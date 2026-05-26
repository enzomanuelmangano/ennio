// EnnioControlSocket.h
//
// Unix-domain socket listener inside the in-app dylib. Replaces the
// previous CDP / __ennioDispatch transport entirely. Wire format:
// line-delimited JSON (one request per line, one response per line).
//
// The socket lives in /tmp/ennio-control.sock — shared between the
// simulator app process and the host CLI because the iOS simulator
// is just a macOS process and /tmp is one filesystem.
//
// Single fixed name: one test run drives one app at a time. Concurrent
// ennio runs against different sims would collide; same constraint
// as Hermes Inspector port 8081. Acceptable.
//
// Pure C++ on purpose: POSIX socket APIs only. ObjC handlers are called
// via a registry of std::function<std::string(const std::string&)>
// installed from ObjC++ on bootstrap. Keeps the socket TU portable +
// the ObjC layer decoupled from POSIX details.

#pragma once

#include <atomic>
#include <functional>
#include <string>

namespace ennio {

/// Handler signature: receives the args JSON (as a string), returns the
/// data JSON for the response (also as a string, may be a primitive
/// like "true" or a JSON object literal). Throw a std::runtime_error to
/// produce an error response.
using EnnioHandler = std::function<std::string(const std::string& argsJson)>;

class EnnioControlSocket {
public:
    /// Absolute filesystem path the server listens on, or empty string
    /// if not started.
    static std::string socketPath();

    /// Bind the socket + spawn the accept thread. Idempotent. Safe to
    /// call from +load. Logs and returns on failure (orphaned socket
    /// file is unlinked + retried automatically).
    static void start();

    /// Register a command handler. Called from ObjC++ on bootstrap to
    /// wire each socket op to its ObjC implementation.
    /// Subsequent registrations of the same op replace the previous.
    /// Thread-safe to call from any thread before or after start().
    static void registerHandler(const std::string& op, EnnioHandler handler);

private:
    static std::atomic<bool> g_started;
};

} // namespace ennio
