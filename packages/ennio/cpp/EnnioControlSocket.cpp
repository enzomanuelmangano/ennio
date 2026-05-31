// EnnioControlSocket.cpp
//
// Listener thread + accept loop + per-connection thread + per-line
// dispatch. Wire format is intentionally trivial: each request is a
// single JSON object on its own line, each response is a single JSON
// object on its own line. No length prefix, no framing tricks.
//
// Why one-thread-per-connection: in practice there's exactly one CLI
// connected at a time. The accept thread spawns a worker for each
// connection so the listener keeps responding to subsequent connects
// without head-of-line blocking. Workers exit when the peer closes.
//
// We deliberately do NOT pull in a JSON library here. The wire format
// is fixed-shape and small. A minimal hand-rolled parser handles
// `{"id":N,"op":"...","args":{...}}` good enough for the protocol. The
// handler receives the raw `args` substring; ObjC++ code parses it
// using NSJSONSerialization where richer access is needed.

#include "EnnioControlSocket.h"

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>

namespace ennio {

std::atomic<bool> EnnioControlSocket::g_started{false};

// Meyers singletons for the handlers map + its mutex.
//
// We can't use plain file-scope statics here: ObjC's `+load` runs at
// dylib attach time, which is BEFORE C++ file-scope constructors are
// guaranteed to have completed (static-initialization-order across
// translation units is undefined). EnnioHandlers.mm's `+load` calls
// registerHandler() from inside that window — touching a not-yet-
// constructed std::map crashes with SIGSEGV during the first insert.
//
// Function-local statics are constructed on first access (C++11
// guarantees thread-safe init), so registerHandler() always sees a
// valid map regardless of when it's called.
static std::map<std::string, EnnioHandler> &handlers() {
    static std::map<std::string, EnnioHandler> instance;
    return instance;
}

static std::mutex &handlersMutex() {
    static std::mutex instance;
    return instance;
}

// Socket path is per-target: ENNIO_SOCKET_PATH env (set by the CLI on
// the simulator's launchctl env, scoped to the UDID), with a legacy
// fallback so an older shim still finds it. The CLI side reads the
// same env var to connect — see src/cli/socket-client.ts.
static const char *kSocketPathFallback = "/tmp/ennio-control.sock";

std::string EnnioControlSocket::socketPath() {
    const char *env = std::getenv("ENNIO_SOCKET_PATH");
    if (env && env[0] != '\0') return env;
    return kSocketPathFallback;
}

void EnnioControlSocket::registerHandler(const std::string &op, EnnioHandler handler) {
    std::lock_guard<std::mutex> lock(handlersMutex());
    handlers()[op] = std::move(handler);
}

// =====================================================================
// Minimal JSON helpers — extract the raw substrings we need from a
// known-shape envelope. Sufficient for parsing the request; ObjC layer
// uses NSJSONSerialization for args.
// =====================================================================

// Find the value substring of a top-level "key":<value> pair. value is
// returned exactly as it appears in source (so a string value still has
// surrounding quotes, an object value starts with '{', etc.). Empty
// string if key not found at top level. NOT a general JSON parser —
// only handles the flat envelope shape.
static std::string extractRawValue(const std::string &json, const std::string &key) {
    std::string needle = "\"" + key + "\"";
    size_t depth = 0;
    bool inString = false;
    bool escape = false;
    size_t i = 0;
    auto match = [&](size_t pos) {
        if (pos + needle.size() > json.size()) return false;
        return json.compare(pos, needle.size(), needle) == 0;
    };
    while (i < json.size()) {
        char c = json[i];
        if (escape) {
            escape = false;
            i++;
            continue;
        }
        if (inString) {
            if (c == '\\') escape = true;
            else if (c == '"') inString = false;
            i++;
            continue;
        }
        if (c == '"') {
            if (depth == 1 && match(i)) {
                // candidate top-level key
                size_t after = i + needle.size();
                while (after < json.size() && (json[after] == ' ' || json[after] == '\t')) after++;
                if (after < json.size() && json[after] == ':') {
                    after++;
                    while (after < json.size() && (json[after] == ' ' || json[after] == '\t'))
                        after++;
                    // extract the value
                    size_t start = after;
                    if (start >= json.size()) return "";
                    char vc = json[start];
                    if (vc == '"') {
                        // string value — return without surrounding quotes
                        size_t end = start + 1;
                        bool esc = false;
                        while (end < json.size()) {
                            char vv = json[end];
                            if (esc) {
                                esc = false;
                                end++;
                                continue;
                            }
                            if (vv == '\\') {
                                esc = true;
                                end++;
                                continue;
                            }
                            if (vv == '"') break;
                            end++;
                        }
                        return json.substr(start + 1, end - start - 1);
                    } else if (vc == '{' || vc == '[') {
                        int subDepth = 0;
                        size_t end = start;
                        bool inStr = false;
                        bool esc = false;
                        while (end < json.size()) {
                            char vv = json[end];
                            if (esc) {
                                esc = false;
                                end++;
                                continue;
                            }
                            if (inStr) {
                                if (vv == '\\') esc = true;
                                else if (vv == '"') inStr = false;
                                end++;
                                continue;
                            }
                            if (vv == '"') inStr = true;
                            else if (vv == '{' || vv == '[') subDepth++;
                            else if (vv == '}' || vv == ']') {
                                subDepth--;
                                if (subDepth == 0) {
                                    end++;
                                    break;
                                }
                            }
                            end++;
                        }
                        return json.substr(start, end - start);
                    } else {
                        // primitive (number, bool, null)
                        size_t end = start;
                        while (end < json.size()) {
                            char vv = json[end];
                            if (vv == ',' || vv == '}' || vv == ']' || vv == ' ' || vv == '\t' ||
                                vv == '\n' || vv == '\r')
                                break;
                            end++;
                        }
                        return json.substr(start, end - start);
                    }
                }
            }
            inString = true;
            i++;
            continue;
        }
        if (c == '{' || c == '[') depth++;
        else if (c == '}' || c == ']') depth--;
        i++;
    }
    return "";
}

// Escape a string for JSON output.
static std::string jsonEscape(const std::string &s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// =====================================================================
// Dispatch
// =====================================================================

static std::string handleRequestLine(const std::string &line) {
    std::string id = extractRawValue(line, "id");
    std::string op = extractRawValue(line, "op");
    std::string args = extractRawValue(line, "args");

    if (op.empty()) {
        return std::string("{\"id\":") + (id.empty() ? std::string("null") : (std::string("\"") + jsonEscape(id) + "\"")) +
               ",\"ok\":false,\"err\":\"missing op\"}";
    }

    EnnioHandler handler;
    {
        std::lock_guard<std::mutex> lock(handlersMutex());
        auto &map = handlers();
        auto it = map.find(op);
        if (it == map.end()) {
            return std::string("{\"id\":") + (id.empty() ? std::string("null") : (std::string("\"") + jsonEscape(id) + "\"")) +
                   ",\"ok\":false,\"err\":\"unknown op: " + jsonEscape(op) + "\"}";
        }
        handler = it->second;
    }

    try {
        std::string data = handler(args.empty() ? std::string("{}") : args);
        if (data.empty()) data = "null";
        return std::string("{\"id\":") + (id.empty() ? std::string("null") : (std::string("\"") + jsonEscape(id) + "\"")) +
               ",\"ok\":true,\"data\":" + data + "}";
    } catch (const std::exception &e) {
        return std::string("{\"id\":") + (id.empty() ? std::string("null") : (std::string("\"") + jsonEscape(id) + "\"")) +
               ",\"ok\":false,\"err\":\"" + jsonEscape(e.what()) + "\"}";
    } catch (...) {
        return std::string("{\"id\":") + (id.empty() ? std::string("null") : (std::string("\"") + jsonEscape(id) + "\"")) +
               ",\"ok\":false,\"err\":\"handler threw unknown exception\"}";
    }
}

// One worker per connection. Reads newline-delimited requests, writes
// newline-delimited responses, exits on EOF or write failure.
static void connectionWorker(int fd) {
    std::string buf;
    buf.reserve(4096);
    char chunk[2048];
    while (true) {
        ssize_t n = read(fd, chunk, sizeof(chunk));
        if (n == 0) break;
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        buf.append(chunk, (size_t)n);

        size_t nl;
        while ((nl = buf.find('\n')) != std::string::npos) {
            std::string line = buf.substr(0, nl);
            buf.erase(0, nl + 1);
            if (line.empty()) continue;
            std::string response = handleRequestLine(line);
            response += '\n';
            const char *p = response.data();
            size_t remaining = response.size();
            bool writeFailed = false;
            while (remaining > 0) {
                ssize_t w = write(fd, p, remaining);
                if (w < 0) {
                    if (errno == EINTR) continue;
                    writeFailed = true;
                    break;
                }
                p += w;
                remaining -= (size_t)w;
            }
            if (writeFailed) {
                close(fd);
                return;
            }
        }
    }
    close(fd);
}

static void acceptLoop(int listenFd) {
    while (true) {
        int fd = accept(listenFd, nullptr, nullptr);
        if (fd < 0) {
            if (errno == EINTR) continue;
            std::fprintf(stderr, "[Ennio] accept() failed: %s\n", std::strerror(errno));
            // Brief backoff to avoid pegging a CPU on persistent failure.
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            continue;
        }
        std::thread(connectionWorker, fd).detach();
    }
}

void EnnioControlSocket::start() {
    bool expected = false;
    if (!g_started.compare_exchange_strong(expected, true)) return;

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        std::fprintf(stderr, "[Ennio] socket() failed: %s\n", std::strerror(errno));
        g_started = false;
        return;
    }

    const std::string path = EnnioControlSocket::socketPath();
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);

    // Clean up any orphaned socket file from a previous run.
    unlink(path.c_str());

    if (bind(fd, (sockaddr *)&addr, sizeof(addr)) < 0) {
        std::fprintf(stderr, "[Ennio] bind(%s) failed: %s\n", path.c_str(), std::strerror(errno));
        close(fd);
        g_started = false;
        return;
    }

    if (listen(fd, 4) < 0) {
        std::fprintf(stderr, "[Ennio] listen() failed: %s\n", std::strerror(errno));
        close(fd);
        unlink(path.c_str());
        g_started = false;
        return;
    }

    // Restrict socket to the owning user. Defense in depth: even on
    // shared dev machines, another user can't connect to drive the app.
    chmod(path.c_str(), 0600);

    std::thread(acceptLoop, fd).detach();
    std::fprintf(stderr, "[Ennio] socket listening on %s\n", path.c_str());
}

} // namespace ennio
