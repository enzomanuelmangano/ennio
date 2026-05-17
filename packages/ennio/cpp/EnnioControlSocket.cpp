// EnnioControlSocket.cpp
//
// Unix domain socket transport that bypasses Hermes Inspector / CDP for
// pure UIKit operations. Sole reason for existing: CDP `Runtime.evaluate`
// queues on the JS thread, so any handler — even one that touches no JS
// state — waits for whatever React work is in flight. Tab swaps on iOS 26
// expose this: native UIKit cost is ~8 ms but CDP wait is ~2 s after a
// destination-tab first-render kicks off on the JS thread.
//
// The socket lives in the app sandbox tmp dir at a stable filename so
// the CLI can discover it via `simctl get_app_container ... data`. Wire
// format = newline-delimited JSON. Server reuses the request/response
// shapes from `Protocol.hpp` so commands here look identical to CDP
// dispatch. Only a whitelisted subset of handlers is wired — anything
// that needs JS thread state (`waitForCommit`, `evalScript`, shadow-tree
// mutations) stays CDP-only.
//
// Pure C++ on purpose — uses POSIX sockets + `getenv("TMPDIR")` so the
// file compiles outside an ObjC++ TU. The whitelisted handlers call into
// `EnnioRuntimeHelper` which is the ObjC++ wrapper around UIKit; that
// indirection keeps the socket server portable and lets it be built into
// the `cpp/` source group of the pod.

#include "EnnioControlSocket.h"

#include "EnnioRuntimeHelper.h"
#include "Protocol.hpp"

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace ennio {

std::atomic<bool> EnnioControlSocket::g_started{false};

static std::string g_socketPath;

static std::string computeSocketPath() {
    // sockaddr_un.sun_path is 104 bytes on macOS. The simulator app's
    // sandbox $TMPDIR is ~140 chars (`.../Containers/Data/Application/
    // <UUID>/tmp/`), too long for bind(). Use the host's `/tmp` — the
    // simulator process is just a macOS process so /tmp is shared with
    // the host, and the CLI runs on the host too.
    //
    // Single fixed name: one test run drives one app at a time. If you
    // ever run multiple Ennio test runs concurrently they'll fight for
    // this socket — same constraint as today's Hermes Inspector port.
    return "/tmp/ennio-control.sock";
}

std::string EnnioControlSocket::socketPath() {
    if (g_socketPath.empty()) g_socketPath = computeSocketPath();
    return g_socketPath;
}

// Handle one request. Single big switch keeps the wire surface explicit
// and audit-able. Adding a new handler is a deliberate act — no
// auto-registration.
static Response dispatchRequest(const Request& req) {
    Response r;
    r.id = req.id;
    r.success = false;

    if (req.type == "tapTabByName") {
        r.success = EnnioRuntimeHelper::getInstance().tapTabByName(
            json::parseString(req.payload, "name"));
    } else if (req.type == "ping") {
        r.success = true;
        r.data = "\"pong\"";
    } else {
        r.error = "unknown_type";
    }
    return r;
}

// Read until newline. Returns false on EOF/error.
static bool readLine(int fd, std::string& out) {
    out.clear();
    char buf[1];
    while (true) {
        ssize_t n = ::read(fd, buf, 1);
        if (n <= 0) return false;
        if (buf[0] == '\n') return true;
        out.push_back(buf[0]);
        if (out.size() > (1u << 20)) return false; // 1 MiB ceiling
    }
}

static bool writeLine(int fd, const std::string& line) {
    std::string framed = line;
    framed.push_back('\n');
    const char* p = framed.data();
    size_t left = framed.size();
    while (left > 0) {
        ssize_t n = ::write(fd, p, left);
        if (n <= 0) return false;
        p += n;
        left -= static_cast<size_t>(n);
    }
    return true;
}

static void serveClient(int fd) {
    std::string line;
    while (readLine(fd, line)) {
        Request req;
        req.id = json::parseString(line, "id");
        req.type = json::parseString(line, "type");
        // payload is itself a JSON object at the "payload" key. The CLI
        // inlines fields; we keep the whole line for downstream
        // parseString lookups — same loose convention as CDP path.
        req.payload = line;
        Response resp = dispatchRequest(req);
        if (!writeLine(fd, resp.toJSON())) break;
    }
    ::close(fd);
}

static void* acceptLoop(void* arg) {
    int srv = static_cast<int>(reinterpret_cast<intptr_t>(arg));
    ::pthread_setname_np("ennio-control-socket");
    while (true) {
        int cfd = ::accept(srv, nullptr, nullptr);
        if (cfd < 0) {
            if (errno == EINTR) continue;
            break;
        }
        // One client at a time. Sequential serves keep UIKit dispatch
        // ordering predictable and side-step multi-writer races on the
        // dispatch table. CLI uses a single persistent connection so
        // there's no real concurrency pressure.
        serveClient(cfd);
    }
    ::close(srv);
    return nullptr;
}

void EnnioControlSocket::start() {
    bool expected = false;
    if (!g_started.compare_exchange_strong(expected, true)) return;

    const std::string path = socketPath();

    // Unlink stale sock from a crashed previous run. Best-effort.
    ::unlink(path.c_str());

    int srv = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (srv < 0) {
        std::fprintf(stderr, "[Ennio][socket] socket() failed: %s\n", std::strerror(errno));
        g_started.store(false);
        return;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (path.size() >= sizeof(addr.sun_path)) {
        std::fprintf(stderr, "[Ennio][socket] path too long (%zu): %s\n", path.size(), path.c_str());
        ::close(srv);
        g_started.store(false);
        return;
    }
    std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);

    if (::bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::fprintf(stderr, "[Ennio][socket] bind(%s) failed: %s\n", path.c_str(), std::strerror(errno));
        ::close(srv);
        g_started.store(false);
        return;
    }

    // 0600 — owner-only. Same user as the simulator process / CLI on a
    // dev box. Other local users on a shared CI box cannot connect.
    ::chmod(path.c_str(), 0600);

    if (::listen(srv, 4) < 0) {
        std::fprintf(stderr, "[Ennio][socket] listen() failed: %s\n", std::strerror(errno));
        ::close(srv);
        ::unlink(path.c_str());
        g_started.store(false);
        return;
    }

    std::fprintf(stderr, "[Ennio][socket] listening on %s\n", path.c_str());

    pthread_t t;
    if (::pthread_create(&t, nullptr, &acceptLoop,
                         reinterpret_cast<void*>(static_cast<intptr_t>(srv))) != 0) {
        std::fprintf(stderr, "[Ennio][socket] pthread_create failed\n");
        ::close(srv);
        ::unlink(path.c_str());
        g_started.store(false);
        return;
    }
    ::pthread_detach(t);
}

} // namespace ennio
