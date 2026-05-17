// EnnioControlSocket.h
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
// shapes from `Protocol.cpp` so commands here look identical to CDP
// dispatch. Only a whitelisted subset of handlers is wired — anything
// that needs JS thread state (`waitForCommit`, `evalScript`, shadow-tree
// mutations) stays CDP-only.

#pragma once

#include <atomic>
#include <string>

namespace ennio {

class EnnioControlSocket {
public:
    // Returns the absolute filesystem path the server listens on, or
    // empty string if not started.
    static std::string socketPath();

    // Idempotent. Binds the socket, spawns an accept thread, and starts
    // serving. Safe to call from `+load` or later. Fails quietly if the
    // socket is already in use (e.g. orphaned from a crashed previous
    // run — unlink + retry).
    static void start();

private:
    static std::atomic<bool> g_started;
};

} // namespace ennio
