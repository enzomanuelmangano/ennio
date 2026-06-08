// ptrace_inject — remote-dlopen a shared library into a running process.
//
// Runs ON-DEVICE as root:  ptrace_inject <pid> <abs-so-path> [caller-hint]
//
// This is ennio's "any app" injection path. `am attach-agent` only works on a
// debuggable process; ptrace works on ANY process (including a non-debuggable
// release build) because root + the debugger syscall bypass the runtime's
// debuggable gate — the same mechanism Frida uses, reduced to the one thing we
// need: load libennio.so. Once loaded, the library's constructor finds the live
// VM and starts the in-process agent (see ennio_inject.cpp), so everything
// downstream is identical to the attach-agent path.
//
// Mechanism: PTRACE_ATTACH → save registers → hijack the target to call the
// dynamic linker's __loader_dlopen(path, RTLD_NOW, caller) → read the returned
// handle → restore registers → detach. We resolve __loader_dlopen's remote
// address by computing its offset within the (shared) linker and rebasing onto
// the target's linker mapping. `caller` selects the linker NAMESPACE: we pass an
// address inside one of the target app's own /data/app libraries so the load
// runs in the app's classloader-namespace, whose permitted_paths cover /data
// (where the agent .so lives).
//
// arm64 today (the emulator + Apple-Silicon dev box); x86_64 added for CI.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <string>
#include <vector>

#include <dlfcn.h>
#include <fcntl.h>
#include <sys/ptrace.h>
#include <sys/uio.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>
#include <elf.h>

namespace {

#define DIE(...)                      \
    do {                              \
        fprintf(stderr, __VA_ARGS__); \
        fprintf(stderr, "\n");        \
        return 1;                     \
    } while (0)

// One mapping line from /proc/<pid>/maps we care about.
struct MapEntry {
    uintptr_t start;
    uintptr_t end;
    std::string path;
};

std::vector<MapEntry> readMaps(int pid) {
    std::vector<MapEntry> out;
    char p[64];
    snprintf(p, sizeof(p), "/proc/%d/maps", pid);
    FILE *f = fopen(p, "r");
    if (!f) return out;
    char line[512];
    while (fgets(line, sizeof(line), f)) {
        uintptr_t a, b;
        char perms[8];
        int n = 0;
        if (sscanf(line, "%lx-%lx %7s %*x %*x:%*x %*d %n", &a, &b, perms, &n) >= 3) {
            std::string path = (n > 0 && line[n]) ? std::string(line + n) : std::string();
            while (!path.empty() && (path.back() == '\n' || path.back() == ' ')) path.pop_back();
            out.push_back({a, b, path});
        }
    }
    fclose(f);
    return out;
}

// Base (lowest start) of the first mapping whose path contains `needle`.
uintptr_t moduleBase(const std::vector<MapEntry> &maps, const char *needle) {
    uintptr_t base = 0;
    for (const auto &m : maps) {
        if (m.path.find(needle) != std::string::npos) {
            if (base == 0 || m.start < base) base = m.start;
        }
    }
    return base;
}

// Full on-disk path of the mapping containing `needle` (e.g. the linker).
std::string modulePath(const std::vector<MapEntry> &maps, const char *needle) {
    for (const auto &m : maps) {
        if (m.path.find(needle) != std::string::npos) return m.path;
    }
    return {};
}

// Parse an ELF64's .dynsym for `sym`, returning its st_value (the offset from
// the module's load base for a base-0 PIE like the linker). 0 if not found.
// We resolve the linker's __loader_dlopen this way instead of linking it: it's a
// runtime-only linker export, not available to the static linker.
uintptr_t elfDynsymValue(const std::string &path, const char *sym) {
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < (long)sizeof(Elf64_Ehdr)) { fclose(f); return 0; }
    std::vector<uint8_t> buf(sz);
    if (fread(buf.data(), 1, sz, f) != (size_t)sz) { fclose(f); return 0; }
    fclose(f);

    auto *eh = reinterpret_cast<Elf64_Ehdr *>(buf.data());
    if (memcmp(eh->e_ident, ELFMAG, SELFMAG) != 0) return 0;
    auto *sh = reinterpret_cast<Elf64_Shdr *>(buf.data() + eh->e_shoff);
    const Elf64_Shdr *dynsym = nullptr, *dynstr = nullptr;
    for (int i = 0; i < eh->e_shnum; i++) {
        if (sh[i].sh_type == SHT_DYNSYM) {
            dynsym = &sh[i];
            if (sh[i].sh_link < eh->e_shnum) dynstr = &sh[sh[i].sh_link];
            break;
        }
    }
    if (!dynsym || !dynstr) return 0;
    auto *syms = reinterpret_cast<Elf64_Sym *>(buf.data() + dynsym->sh_offset);
    const char *strs = reinterpret_cast<const char *>(buf.data() + dynstr->sh_offset);
    size_t count = dynsym->sh_size / sizeof(Elf64_Sym);
    for (size_t i = 0; i < count; i++) {
        const char *name = strs + syms[i].st_name;
        if (strcmp(name, sym) == 0) return syms[i].st_value;
    }
    return 0;
}

// An address inside one of the target's own app libraries (/data/app/.../lib),
// used as the dlopen caller so the load runs in the app's namespace.
uintptr_t appLibCaller(const std::vector<MapEntry> &maps) {
    for (const auto &m : maps) {
        if (m.path.find("/data/app/") != std::string::npos && m.path.find(".so") != std::string::npos) {
            return m.start;
        }
    }
    return 0;
}

bool writeMem(int pid, uintptr_t remote, const void *buf, size_t len) {
    struct iovec local { const_cast<void *>(buf), len };
    struct iovec rem { reinterpret_cast<void *>(remote), len };
    return process_vm_writev(pid, &local, 1, &rem, 1, 0) == (ssize_t)len;
}

// ── arch abstraction ──────────────────────────────────────────────────────
// A remote function call hijacks the target: set arg registers + pc, point the
// return address at 0 so the function faults (SIGSEGV) on return and we regain
// control, then read the return register.
#if defined(__aarch64__)
using Regs = user_pt_regs;
bool getRegs(int pid, Regs *r) {
    struct iovec io { r, sizeof(*r) };
    return ptrace(PTRACE_GETREGSET, pid, (void *)NT_PRSTATUS, &io) == 0;
}
bool setRegs(int pid, Regs *r) {
    struct iovec io { r, sizeof(*r) };
    return ptrace(PTRACE_SETREGSET, pid, (void *)NT_PRSTATUS, &io) == 0;
}
void setupCall(int /*pid*/, Regs &w, const Regs &orig, uintptr_t fn, uintptr_t a0,
               uintptr_t a1, uintptr_t a2, uintptr_t scratch) {
    w = orig;
    w.regs[0] = a0;
    w.regs[1] = a1;
    w.regs[2] = a2;
    w.regs[30] = 0;                       // lr = 0 → fault on return
    w.sp = (scratch - 0x100) & ~0xFUL;    // 16-aligned
    w.pc = fn;
}
uintptr_t retval(const Regs &r) { return r.regs[0]; }

#elif defined(__x86_64__)
using Regs = user_regs_struct;
bool getRegs(int pid, Regs *r) { return ptrace(PTRACE_GETREGS, pid, 0, r) == 0; }
bool setRegs(int pid, Regs *r) { return ptrace(PTRACE_SETREGS, pid, 0, r) == 0; }
void setupCall(int pid, Regs &w, const Regs &orig, uintptr_t fn, uintptr_t a0,
               uintptr_t a1, uintptr_t a2, uintptr_t scratch) {
    w = orig;
    w.rdi = a0;
    w.rsi = a1;
    w.rdx = a2;
    // Place a return address of 0 on the stack so the callee's `ret` faults.
    // SysV wants rsp%16==8 at function entry (i.e. just after the call push).
    uintptr_t top = (scratch - 0x100) & ~0xFUL;
    uintptr_t retSlot = top - 8;
    uint64_t zero = 0;
    struct iovec local { &zero, sizeof(zero) };
    struct iovec rem { reinterpret_cast<void *>(retSlot), sizeof(zero) };
    process_vm_writev(pid, &local, 1, &rem, 1, 0);
    w.rsp = retSlot;
    w.rip = fn;
}
uintptr_t retval(const Regs &r) { return r.rax; }

#else
#error "unsupported architecture"
#endif

} // namespace

// st_value from the (base-0 PIE) linker ELF is the offset from its load base on
// arm64. On x86_64 the linker is non-PIE-ish in some images; rebasing by the
// mapped base still holds because we read the SAME file the target mapped.
int main(int argc, char **argv) {
    if (argc < 3) DIE("usage: ptrace_inject <pid> <abs-so-path>");
    int pid = atoi(argv[1]);
    const char *soPath = argv[2];

    // Resolve remote __loader_dlopen: linker base (from target maps) + the
    // symbol's st_value (from the linker ELF on disk).
    auto tgtMaps = readMaps(pid);
    if (tgtMaps.empty()) DIE("cannot read /proc/%d/maps (root? pid alive?)", pid);

    const char *LINKER = "linker64";
    uintptr_t tgtLinker = moduleBase(tgtMaps, LINKER);
    std::string linkerPath = modulePath(tgtMaps, LINKER);
    if (!tgtLinker || linkerPath.empty()) DIE("linker64 not found in target maps");
    uintptr_t dlopenOff = elfDynsymValue(linkerPath, "__loader_dlopen");
    if (!dlopenOff) DIE("__loader_dlopen not found in %s", linkerPath.c_str());
    uintptr_t remoteDlopen = tgtLinker + dlopenOff;

    uintptr_t caller = appLibCaller(tgtMaps);
    if (!caller) caller = moduleBase(tgtMaps, "libc.so"); // fallback namespace
    if (!caller) DIE("no caller library found in target");

    printf("pid=%d remoteDlopen=%p caller=%p so=%s\n", pid, (void *)remoteDlopen,
           (void *)caller, soPath);

    if (ptrace(PTRACE_ATTACH, pid, 0, 0) != 0) DIE("PTRACE_ATTACH failed: %s", strerror(errno));
    int st;
    waitpid(pid, &st, 0);

    Regs orig{}, work{};
    if (!getRegs(pid, &orig)) { ptrace(PTRACE_DETACH, pid, 0, 0); DIE("getRegs failed"); }

    // Scratch below the stack pointer: write the so path string there.
#if defined(__aarch64__)
    uintptr_t sp = orig.sp;
#else
    uintptr_t sp = orig.rsp;
#endif
    uintptr_t scratch = (sp - 0x400) & ~0xFUL;
    if (!writeMem(pid, scratch, soPath, strlen(soPath) + 1)) {
        ptrace(PTRACE_DETACH, pid, 0, 0);
        DIE("writeMem(path) failed: %s", strerror(errno));
    }

    // __loader_dlopen(path, RTLD_NOW=2, caller). caller_addr is an explicit arg
    // (selects the app namespace), decoupled from the return address.
    setupCall(pid, work, orig, remoteDlopen, scratch, 0x2, caller, scratch);
    if (!setRegs(pid, &work)) { ptrace(PTRACE_DETACH, pid, 0, 0); DIE("setRegs failed"); }

    ptrace(PTRACE_CONT, pid, 0, 0); // runs dlopen, faults at return addr 0
    waitpid(pid, &st, 0);

    uintptr_t handle = 0;
    if (WIFSTOPPED(st)) {
        Regs after{};
        if (getRegs(pid, &after)) handle = retval(after);
        int sig = WSTOPSIG(st);
        if (sig != SIGSEGV) fprintf(stderr, "note: stopped by signal %d (expected SIGSEGV)\n", sig);
    } else {
        fprintf(stderr, "target did not stop as expected (status=0x%x)\n", st);
    }

    setRegs(pid, &orig); // restore + detach regardless
    ptrace(PTRACE_DETACH, pid, 0, 0);

    if (handle == 0) DIE("dlopen returned NULL (handle=0) — load failed");
    printf("OK dlopen handle=%p\n", (void *)handle);
    return 0;
}
