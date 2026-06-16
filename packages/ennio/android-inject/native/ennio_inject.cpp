// ennio_inject — the native injection agent (Android parity with the iOS
// dylib). This is a JVMTI agent: it is bundled inside the (debuggable) app's
// APK as a regular native library and attached on demand with
//
//     adb shell am attach-agent <pid> <nativeLibDir>/libennio.so
//
// The runtime calls Agent_OnAttach(JavaVM*, ...) on an attached runtime
// thread once the process is up, handing us the live VM directly. From there:
//
//   1. get a JNIEnv for this thread,
//   2. read ActivityThread.currentApplication() (non-null — we attach after
//      the app is running),
//   3. load the embedded agent dex via InMemoryDexClassLoader (parented to
//      the app's own classloader, so it sees framework + app classes),
//   4. invoke ennio.inject.EnnioAgent.start(Application).
//
// This deliberately replaces the old LD_PRELOAD/wrap.sh bootstrap. wrap.sh
// relaunches the app through a shell wrapper whose first wrapped process can
// take SIGSYS (seccomp setgid) during privilege setup — a ~1/3 race that the
// CLI had to paper over with retries. am attach-agent has no shell, no
// re-exec, no seccomp setgid: the attach either loads the agent or fails
// loudly. Deterministic, not probabilistic.
//
// The agent is never part of the app's own code: it lives in this .so as a
// dex blob, so any debuggable app can be driven without recompiling IT — only
// this stub library is bundled. SELinux note: the app may READ but not
// map-executable from /data/local/tmp, so the .so must sit in the app's
// nativeLibraryDir (i.e. bundled in the APK), which is map-exec by design.

#include <jni.h>
#include <android/log.h>
#include <dlfcn.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/un.h>

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

#include "agent_dex.h" // unsigned char agent_dex[]; unsigned int agent_dex_len;

// Iteration override: if this dex exists, load it instead of the embedded
// one. Lets the agent dex be rebuilt + pushed without rebuilding the .so/APK.
// (The .so itself still has to be reinstalled to change, but the agent's
// behaviour lives in the dex, which iterates fast.)
#define ENNIO_DEX_OVERRIDE "/data/local/tmp/ennio-agent.dex"

// Pathological backstop for the currentApplication() wait: 600 × 50ms = 30s.
// NOT a tuning knob — a normal cold start resolves in well under a second, and
// the host gives up on a wedged bootstrap far sooner (its bootstrap-wait). This
// only stops a truly orphaned thread from spinning forever if the process
// somehow outlives the host.
#define ENNIO_APP_WAIT_TICKS 600

#define LOG_TAG "EnnioInject"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// Early "the constructor ran" beacon. Bound in the loader's constructor —
// which dlopen runs SYNCHRONOUSLY before it returns — so by the time the ptrace
// injector prints "OK dlopen", this abstract socket exists IFF the agent code
// actually started executing in the target. It needs no VM, no JNI, no
// Application: it's pure POSIX, so it can't be delayed by the cold-start work
// that the real @ennio_<pid> bind waits on.
//
// The host uses it to split the dominant "dlopen ok but @ennio never bound"
// failure into two very different cases:
//   * up-marker ABSENT  → the constructor never ran (a ptrace/loader no-op):
//                         the inject is dead, relaunch immediately.
//   * up-marker PRESENT  → the agent is alive and bootstrapping (waiting for
//                         the VM / Application): do NOT relaunch, give it the
//                         bootstrap budget to bind for real.
// Conflating these is what made the retry loop both too eager (relaunching a
// healthy-but-slow bootstrap) and too slow (re-rolling a dead inject after a
// fixed wait). Leaks the fd intentionally (process lifetime).
void bind_up_marker() {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    // Abstract namespace: leading NUL, name follows.
    int n = snprintf(addr.sun_path + 1, sizeof(addr.sun_path) - 2, "ennio_up_%d", getpid());
    socklen_t len = static_cast<socklen_t>(offsetof(struct sockaddr_un, sun_path) + 1 + n);
    if (bind(fd, reinterpret_cast<struct sockaddr *>(&addr), len) != 0) {
        close(fd);
        return;
    }
    listen(fd, 1); // makes it show in /proc/net/unix consistently
    LOGI("up-marker bound @ennio_up_%d", getpid());
}

// Clear any pending JNI exception; returns true if one was pending.
bool clearException(JNIEnv *env) {
    if (env->ExceptionCheck()) {
        env->ExceptionDescribe();
        env->ExceptionClear();
        return true;
    }
    return false;
}

jobject currentApplication(JNIEnv *env) {
    jclass at = env->FindClass("android/app/ActivityThread");
    if (!at || clearException(env)) return nullptr;
    jmethodID m = env->GetStaticMethodID(at, "currentApplication", "()Landroid/app/Application;");
    if (!m || clearException(env)) return nullptr;
    jobject app = env->CallStaticObjectMethod(at, m);
    clearException(env);
    return app;
}

// Load the override dex into a heap buffer, or fall back to the embedded
// blob. Returns the bytes/len via out-params; *owned is non-null (must be
// freed) only when the override file was read.
void resolveDex(const unsigned char **bytes, unsigned int *len, void **owned) {
    *owned = nullptr;
    FILE *f = fopen(ENNIO_DEX_OVERRIDE, "rb");
    if (f) {
        fseek(f, 0, SEEK_END);
        long n = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (n > 0) {
            void *buf = malloc(static_cast<size_t>(n));
            if (buf && fread(buf, 1, static_cast<size_t>(n), f) == static_cast<size_t>(n)) {
                fclose(f);
                LOGI("using override dex %s (%ld bytes)", ENNIO_DEX_OVERRIDE, n);
                *bytes = static_cast<unsigned char *>(buf);
                *len = static_cast<unsigned int>(n);
                *owned = buf;
                return;
            }
            free(buf);
        }
        fclose(f);
    }
    *bytes = agent_dex;
    *len = agent_dex_len;
}

bool startAgent(JNIEnv *env, jobject application) {
    // app.getClassLoader()
    jclass ctxClass = env->FindClass("android/content/Context");
    jmethodID getCl = env->GetMethodID(ctxClass, "getClassLoader", "()Ljava/lang/ClassLoader;");
    jobject parentLoader = env->CallObjectMethod(application, getCl);
    if (clearException(env) || !parentLoader) {
        LOGE("getClassLoader failed");
        return false;
    }

    const unsigned char *dexBytes = nullptr;
    unsigned int dexLen = 0;
    void *dexOwned = nullptr;
    resolveDex(&dexBytes, &dexLen, &dexOwned);

    // ByteBuffer over the dex (embedded blob or override). The buffer must
    // stay valid for the lifetime of the classloader, so override bytes are
    // intentionally leaked (process-lifetime); the embedded blob is static.
    jobject buffer = env->NewDirectByteBuffer(
        const_cast<unsigned char *>(dexBytes), static_cast<jlong>(dexLen));
    if (clearException(env) || !buffer) {
        LOGE("NewDirectByteBuffer failed");
        return false;
    }

    // new InMemoryDexClassLoader(ByteBuffer, ClassLoader)
    jclass imdcl = env->FindClass("dalvik/system/InMemoryDexClassLoader");
    if (clearException(env) || !imdcl) {
        LOGE("InMemoryDexClassLoader not found");
        return false;
    }
    jmethodID ctor = env->GetMethodID(
        imdcl, "<init>", "(Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V");
    jobject loader = env->NewObject(imdcl, ctor, buffer, parentLoader);
    if (clearException(env) || !loader) {
        LOGE("InMemoryDexClassLoader ctor failed");
        return false;
    }

    // loader.loadClass("ennio.inject.EnnioAgent")
    jclass clClass = env->GetObjectClass(loader);
    jmethodID loadClass =
        env->GetMethodID(clClass, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;");
    jstring name = env->NewStringUTF("ennio.inject.EnnioAgent");
    jobject agentClassObj = env->CallObjectMethod(loader, loadClass, name);
    if (clearException(env) || !agentClassObj) {
        LOGE("loadClass EnnioAgent failed");
        return false;
    }
    jclass agentClass = static_cast<jclass>(agentClassObj);

    // EnnioAgent.start(Application)
    jmethodID startM =
        env->GetStaticMethodID(agentClass, "start", "(Landroid/app/Application;)V");
    if (clearException(env) || !startM) {
        LOGE("EnnioAgent.start method not found");
        return false;
    }
    env->CallStaticVoidMethod(agentClass, startM, application);
    if (clearException(env)) {
        LOGE("EnnioAgent.start threw");
        return false;
    }
    LOGI("EnnioAgent.start invoked");
    return true;
}

// Shared entry for both attach paths. The VM is live and started by the time
// the runtime calls us, so there is no waitForVm / runtime-started polling —
// the whole probabilistic bootstrap is gone.
// Start at most once. Both entry paths can fire for a single load — the JVMTI
// runtime calls Agent_OnAttach AND dlopen runs this library's constructor — so
// whichever reaches here first wins and the other is a no-op.
volatile char g_started = 0;

jint attach(JavaVM *vm, const char *how) {
    if (__atomic_test_and_set(&g_started, __ATOMIC_SEQ_CST)) {
        return JNI_OK; // already started by the other entry path
    }
    LOGI("Agent_%s pid=%d", how, getpid());
    JNIEnv *env = nullptr;
    bool weAttached = false;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK || !env) {
        if (vm->AttachCurrentThread(&env, nullptr) != JNI_OK || !env) {
            LOGE("AttachCurrentThread failed");
            return JNI_ERR;
        }
        weAttached = true;
    }

    // Wait for the Application to be constructed. The ptrace injector fires the
    // instant `pidof` returns — that's the zygote fork, well before
    // ActivityThread.handleBindApplication runs — so currentApplication() is
    // null at first and turns non-null on an EVENT. On a loaded CI emulator that
    // can take several seconds. The OLD 5s cap made the agent SELF-ABORT mid
    // cold-start, leaving no socket bound; that is the bulk of the "dlopen ok
    // but @ennio never bound" failures. Wait for the event instead: this thread
    // runs INSIDE the target, so the process's own lifetime bounds it (a dead
    // app reaps this thread). The cap below is only a pathological backstop, set
    // well ABOVE the host's bootstrap-wait so the host always relaunches a truly
    // wedged process first — it never cuts off a normal (even slow) cold start.
    jobject app = nullptr;
    for (int i = 0; i < ENNIO_APP_WAIT_TICKS && !app; i++) {
        app = currentApplication(env);
        if (app) break;
        if (i == 20) LOGI("still waiting for currentApplication (cold start) pid=%d", getpid());
        usleep(50 * 1000);
    }
    jint rc = JNI_OK;
    if (!app) {
        LOGE("currentApplication never became non-null pid=%d", getpid());
        rc = JNI_ERR;
    } else {
        LOGI("currentApplication ready pid=%d", getpid());
        if (!startAgent(env, app)) rc = JNI_ERR;
    }

    // The agent spawns its own (attached) threads for the socket server; this
    // attach thread is done. Detach only if WE attached it.
    if (weAttached) vm->DetachCurrentThread();
    return rc;
}

// Find the already-running VM. Used by the constructor path (a plain dlopen,
// e.g. ptrace injection) where nobody hands us a JavaVM. The app is live, so
// the VM exists — a short retry only covers an injection that lands a beat
// before the runtime finishes publishing it.
using GetCreatedVMsFn = jint (*)(JavaVM **, jsize, jsize *);

JavaVM *runningVm() {
    GetCreatedVMsFn fn =
        reinterpret_cast<GetCreatedVMsFn>(dlsym(RTLD_DEFAULT, "JNI_GetCreatedJavaVMs"));
    if (!fn) {
        void *h = dlopen("libnativehelper.so", RTLD_NOW);
        if (h) fn = reinterpret_cast<GetCreatedVMsFn>(dlsym(h, "JNI_GetCreatedJavaVMs"));
    }
    if (!fn) {
        LOGE("JNI_GetCreatedJavaVMs unavailable");
        return nullptr;
    }
    for (int i = 0; i < 200; i++) {
        JavaVM *vm = nullptr;
        jsize n = 0;
        if (fn(&vm, 1, &n) == JNI_OK && n > 0 && vm) return vm;
        usleep(25 * 1000);
    }
    return nullptr;
}

void *bootstrapThread(void *) {
    JavaVM *vm = runningVm();
    if (vm) {
        attach(vm, "ctor");
    } else {
        LOGE("no running VM — ctor bootstrap gave up");
    }
    return nullptr;
}

} // namespace

// Runtime-attach entry (`am attach-agent <pid> <so>`): the ART runtime calls
// this with the live VM. Used for a DEBUGGABLE target.
extern "C" JNIEXPORT jint JNICALL
Agent_OnAttach(JavaVM *vm, char * /*options*/, void * /*reserved*/) {
    bind_up_marker(); // "agent code reached this process" beacon
    return attach(vm, "OnAttach");
}

// Load-time entry (`--attach-agent-bind`, or -agentpath). Harmless to support.
extern "C" JNIEXPORT jint JNICALL
Agent_OnLoad(JavaVM *vm, char * /*options*/, void * /*reserved*/) {
    return attach(vm, "OnLoad");
}

// Constructor entry: runs on ANY dlopen of this library, including a ptrace
// injector's remote dlopen into a NON-debuggable process (where am attach-agent
// is refused). Spawns a thread that finds the running VM and starts the agent —
// the g_started guard makes this idempotent with Agent_OnAttach.
__attribute__((constructor)) static void ennio_ctor() {
    // Bind the beacon SYNCHRONOUSLY here (dlopen runs the ctor before it
    // returns), so the host can tell "the ptrace dlopen actually ran our code"
    // from "dlopen reported OK but nothing executed" the moment inject returns.
    bind_up_marker();
    pthread_t t;
    if (pthread_create(&t, nullptr, bootstrapThread, nullptr) == 0) {
        pthread_detach(t);
    } else {
        LOGE("pthread_create failed in ctor");
    }
}
