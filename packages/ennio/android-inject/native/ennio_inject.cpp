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

#define LOG_TAG "EnnioInject"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

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
jint attach(JavaVM *vm, const char *how) {
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

    // We attach AFTER the app is running, so currentApplication() is normally
    // non-null immediately. Keep a short BOUNDED poll only to cover an attach
    // that lands a few ms before Application.onCreate returns — deterministic,
    // not the old open-ended wait-for-runtime.
    jobject app = nullptr;
    for (int i = 0; i < 100 && !app; i++) {
        app = currentApplication(env);
        if (!app) usleep(50 * 1000);
    }
    jint rc = JNI_OK;
    if (!app) {
        LOGE("currentApplication never became non-null");
        rc = JNI_ERR;
    } else if (!startAgent(env, app)) {
        rc = JNI_ERR;
    }

    // The agent spawns its own (attached) threads for the socket server; this
    // attach thread is done. Detach only if WE attached it.
    if (weAttached) vm->DetachCurrentThread();
    return rc;
}

} // namespace

// Runtime-attach entry (`am attach-agent <pid> <so>` / `am start
// --attach-agent <so>`). This is the path ennio uses.
extern "C" JNIEXPORT jint JNICALL
Agent_OnAttach(JavaVM *vm, char * /*options*/, void * /*reserved*/) {
    return attach(vm, "OnAttach");
}

// Load-time entry (`--attach-agent-bind`, or -agentpath). Harmless to support;
// currentApplication() may not be ready this early, hence the bounded poll.
extern "C" JNIEXPORT jint JNICALL
Agent_OnLoad(JavaVM *vm, char * /*options*/, void * /*reserved*/) {
    return attach(vm, "OnLoad");
}
