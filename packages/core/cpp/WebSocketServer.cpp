#include "WebSocketServer.hpp"

#include <chrono>
#include <cstring>
#include <sstream>
#include <iomanip>
#include <cerrno>
#include <algorithm>

#ifdef __APPLE__
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <CommonCrypto/CommonDigest.h>
// Use NSLog for iOS logging
extern "C" void EnnioLogMessage(const char* message);
#define WS_LOG(fmt, ...) do { \
    char buf[512]; \
    snprintf(buf, sizeof(buf), "[Ennio WS] " fmt, ##__VA_ARGS__); \
    EnnioLogMessage(buf); \
} while(0)
#elif defined(__ANDROID__)
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <arpa/inet.h>
// Android: use OpenSSL
#include <openssl/sha.h>
#include <android/log.h>
#define WS_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "Ennio WS", fmt, ##__VA_ARGS__)
#else
#define WS_LOG(fmt, ...) fprintf(stderr, "[Ennio WS] " fmt "\n", ##__VA_ARGS__)
#endif

namespace ennio {

// Base64 encoding table
static const char base64Chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Base64 encoding for WebSocket handshake
static std::string base64Encode(const unsigned char* data, size_t length) {
    std::string result;
    result.reserve(((length + 2) / 3) * 4);

    for (size_t i = 0; i < length; i += 3) {
        unsigned int b = (data[i] << 16);
        if (i + 1 < length) b |= (data[i + 1] << 8);
        if (i + 2 < length) b |= data[i + 2];

        result += base64Chars[(b >> 18) & 0x3F];
        result += base64Chars[(b >> 12) & 0x3F];
        result += (i + 1 < length) ? base64Chars[(b >> 6) & 0x3F] : '=';
        result += (i + 2 < length) ? base64Chars[b & 0x3F] : '=';
    }

    return result;
}

// SHA-1 hash function
static void sha1Hash(const std::string& input, unsigned char* output) {
#ifdef __APPLE__
    CC_SHA1(input.c_str(), static_cast<CC_LONG>(input.length()), output);
#elif defined(__ANDROID__)
    SHA1(reinterpret_cast<const unsigned char*>(input.c_str()), input.length(), output);
#endif
}

// JSON escape for response fields populated from external input (request
// id, exception messages). Keeps the toJSON() output well-formed when an
// id or error contains '"', '\', or a control character.
static std::string jsonEscape(const std::string& str) {
    std::string out;
    out.reserve(str.size() + 8);
    for (char c : str) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

std::string Response::toJSON() const {
    std::ostringstream oss;
    oss << "{";
    oss << "\"id\":\"" << jsonEscape(id) << "\",";
    oss << "\"success\":" << (success ? "true" : "false");

    if (!data.empty()) {
        oss << ",\"data\":" << data;
    }

    if (!error.empty()) {
        oss << ",\"error\":\"" << jsonEscape(error) << "\"";
    }

    oss << "}";
    return oss.str();
}

WebSocketServer::WebSocketServer()
    : port_(0)
    , serverSocket_(-1)
    , running_(false) {
}

WebSocketServer::~WebSocketServer() {
    stop();
}

bool WebSocketServer::start(int port) {
    WS_LOG("start() called with port=%d", port);

    if (port < 1 || port > 65535) {
        WS_LOG("start() - invalid port %d", port);
        return false;
    }
    if (running_) {
        WS_LOG("start() - already running");
        return false;
    }

    port_ = port;

    // Create socket
    serverSocket_ = socket(AF_INET, SOCK_STREAM, 0);
    if (serverSocket_ < 0) {
        WS_LOG("start() - socket() failed");
        return false;
    }

    // Allow address reuse
    int opt = 1;
    setsockopt(serverSocket_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    // Bind to loopback only — Ennio is a same-host dev tool. Refusing
    // off-host connections eliminates the LAN attack surface even if a
    // build with Ennio enabled accidentally ships.
    struct sockaddr_in addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);

    if (bind(serverSocket_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        close(serverSocket_);
        serverSocket_ = -1;
        return false;
    }

    // Listen
    if (listen(serverSocket_, 5) < 0) {
        WS_LOG("start() - listen() failed");
        close(serverSocket_);
        serverSocket_ = -1;
        return false;
    }

    WS_LOG("start() - socket bound and listening");

    running_ = true;
    serverThread_ = std::thread(&WebSocketServer::serverLoop, this);

    WS_LOG("start() - server thread started");

    return true;
}

void WebSocketServer::stop() {
    if (!running_) {
        return;
    }

    running_ = false;

    // Close server socket to interrupt accept()
    if (serverSocket_ >= 0) {
        close(serverSocket_);
        serverSocket_ = -1;
    }

    // Close client sockets
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (int clientSocket : clients_) {
            close(clientSocket);
        }
        clients_.clear();
    }

    // Wait for server thread
    if (serverThread_.joinable()) {
        serverThread_.join();
    }
}

bool WebSocketServer::isRunning() const {
    return running_;
}

int WebSocketServer::getPort() const {
    return port_;
}

void WebSocketServer::setCommandHandler(CommandHandler handler) {
    std::lock_guard<std::mutex> lock(mutex_);
    commandHandler_ = std::move(handler);
}

void WebSocketServer::sendResponse(int clientId, const Response& response) {
    std::string json = response.toJSON();
    auto frame = buildFrame(json);

    send(clientId, frame.data(), frame.size(), 0);
}

void WebSocketServer::broadcast(const std::string& message) {
    auto frame = buildFrame(message);

    std::lock_guard<std::mutex> lock(mutex_);
    for (int clientSocket : clients_) {
        send(clientSocket, frame.data(), frame.size(), 0);
    }
}

int WebSocketServer::getClientCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return static_cast<int>(clients_.size());
}

void WebSocketServer::serverLoop() {
    WS_LOG("serverLoop() - started, waiting for connections");

    // Exponential backoff on accept errors so an EMFILE / fd-exhaustion
    // doesn't pin a CPU spinning on the failing accept().
    int acceptBackoffMs = 0;
    while (running_) {
        struct sockaddr_in clientAddr;
        socklen_t clientLen = sizeof(clientAddr);

        int clientSocket = accept(serverSocket_, (struct sockaddr*)&clientAddr, &clientLen);
        if (clientSocket < 0) {
            if (!running_) {
                WS_LOG("serverLoop() - server stopped");
                break;
            }
            WS_LOG("serverLoop() - accept error errno=%d, backoff=%dms", errno, acceptBackoffMs);
            if (acceptBackoffMs > 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(acceptBackoffMs));
            }
            acceptBackoffMs = acceptBackoffMs == 0 ? 10 : std::min(acceptBackoffMs * 2, 1000);
            continue;
        }
        acceptBackoffMs = 0;

        WS_LOG("serverLoop() - accepted connection, socket=%d", clientSocket);

        // Handle client in a new thread
        std::thread clientThread(&WebSocketServer::handleClient, this, clientSocket);
        clientThread.detach();
    }

    WS_LOG("serverLoop() - exiting");
}

void WebSocketServer::handleClient(int clientSocket) {
    WS_LOG("handleClient() - new client socket=%d", clientSocket);

    // Perform WebSocket handshake
    if (!performHandshake(clientSocket)) {
        WS_LOG("handleClient() - handshake failed");
        close(clientSocket);
        return;
    }

    WS_LOG("handleClient() - handshake successful");

    // Set socket receive timeout (30 seconds)
    struct timeval tv;
    tv.tv_sec = 30;
    tv.tv_usec = 0;
    setsockopt(clientSocket, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    // Add to client list
    {
        std::lock_guard<std::mutex> lock(mutex_);
        clients_.push_back(clientSocket);
    }

    // Per-connection accumulator. WebSocket frames can split across
    // recv() calls (large request body, congested loopback, RN's bridge
    // chunking) — without this, parseFrame would see only the half it
    // got, return "", and the second half would arrive on the next recv
    // with no header and be silently dropped.
    std::vector<uint8_t> accum;
    uint8_t recvBuf[4096];
    while (running_) {
        ssize_t bytesRead = recv(clientSocket, recvBuf, sizeof(recvBuf), 0);
        if (bytesRead < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
            WS_LOG("handleClient() - recv error: %d", errno);
            break;
        }
        if (bytesRead == 0) {
            WS_LOG("handleClient() - connection closed by client");
            break;
        }
        accum.insert(accum.end(), recvBuf, recvBuf + bytesRead);

        // Drain as many complete frames as the buffer holds. parseFrame
        // returns ("", consumed=0) when more bytes are needed.
        while (true) {
            size_t consumed = 0;
            std::string message = parseFrame(accum, &consumed);
            if (consumed == 0) break;
            accum.erase(accum.begin(), accum.begin() + consumed);
            if (message.empty()) continue; // ping/pong/close — skipped at protocol layer

            WS_LOG("handleClient() - received message: %.100s...", message.c_str());
            Request request = parseRequest(message);
            WS_LOG("handleClient() - parsed request type=%s id=%s", request.type.c_str(), request.id.c_str());

            CommandHandler handler;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                handler = commandHandler_;
            }

            if (!handler) {
                WS_LOG("handleClient() - no command handler set!");
                continue;
            }
            WS_LOG("handleClient() - calling command handler");
            try {
                Response response = handler(request);
                WS_LOG("handleClient() - handler returned success=%d", response.success);
                sendResponse(clientSocket, response);
                WS_LOG("handleClient() - response sent");
            } catch (const std::exception& e) {
                WS_LOG("handleClient() - EXCEPTION in handler: %s", e.what());
                Response errorResponse;
                errorResponse.id = request.id;
                errorResponse.success = false;
                errorResponse.error = std::string("Internal error: ") + e.what();
                sendResponse(clientSocket, errorResponse);
            } catch (...) {
                WS_LOG("handleClient() - UNKNOWN EXCEPTION in handler");
                Response errorResponse;
                errorResponse.id = request.id;
                errorResponse.success = false;
                errorResponse.error = "Internal error: unknown exception";
                sendResponse(clientSocket, errorResponse);
            }
        }
    }

    // Remove from client list
    {
        std::lock_guard<std::mutex> lock(mutex_);
        clients_.erase(
            std::remove(clients_.begin(), clients_.end(), clientSocket),
            clients_.end()
        );
    }

    close(clientSocket);
}

std::string WebSocketServer::parseFrame(const std::vector<uint8_t>& data, size_t* consumed) {
    if (consumed) *consumed = 0;
    if (data.size() < 2) return "";

    uint8_t opcode = data[0] & 0x0F;
    bool masked = (data[1] & 0x80) != 0;
    uint64_t payloadLen = data[1] & 0x7F;
    size_t offset = 2;

    if (payloadLen == 126) {
        if (data.size() < 4) return "";
        payloadLen = (uint64_t(data[2]) << 8) | data[3];
        offset = 4;
    } else if (payloadLen == 127) {
        if (data.size() < 10) return "";
        payloadLen = 0;
        for (int i = 0; i < 8; i++) {
            payloadLen = (payloadLen << 8) | data[2 + i];
        }
        offset = 10;
    }

    uint8_t maskKey[4] = {0, 0, 0, 0};
    if (masked) {
        if (data.size() < offset + 4) return "";
        std::memcpy(maskKey, data.data() + offset, 4);
        offset += 4;
    }

    if (data.size() < offset + payloadLen) return "";

    // Frame complete. Caller advances by the full header+payload size.
    if (consumed) *consumed = offset + static_cast<size_t>(payloadLen);

    // Opcode 0x8 = close. Signal by returning empty string with consumed > 0;
    // caller treats empty-but-consumed as "control frame, not a message".
    // 0x9/0xA = ping/pong, similarly ignored. Only 0x1 (text) routes to the
    // command handler.
    if (opcode != 0x1) return "";

    std::string result;
    result.reserve(static_cast<size_t>(payloadLen));
    for (uint64_t i = 0; i < payloadLen; i++) {
        char c = static_cast<char>(data[offset + i]);
        if (masked) c ^= maskKey[i % 4];
        result += c;
    }
    return result;
}

std::vector<uint8_t> WebSocketServer::buildFrame(const std::string& message) {
    std::vector<uint8_t> frame;

    // Text frame, FIN bit set
    frame.push_back(0x81);

    // Payload length (server to client is not masked)
    size_t len = message.size();
    if (len <= 125) {
        frame.push_back(static_cast<uint8_t>(len));
    } else if (len <= 65535) {
        frame.push_back(126);
        frame.push_back((len >> 8) & 0xFF);
        frame.push_back(len & 0xFF);
    } else {
        frame.push_back(127);
        for (int i = 7; i >= 0; i--) {
            frame.push_back((len >> (i * 8)) & 0xFF);
        }
    }

    // Payload
    frame.insert(frame.end(), message.begin(), message.end());

    return frame;
}

bool WebSocketServer::performHandshake(int clientSocket) {
    char buffer[4096];
    ssize_t bytesRead = recv(clientSocket, buffer, sizeof(buffer) - 1, 0);
    if (bytesRead <= 0) {
        return false;
    }
    buffer[bytesRead] = '\0';

    // Find Sec-WebSocket-Key
    std::string request(buffer);
    std::string keyHeader = "Sec-WebSocket-Key: ";
    size_t keyPos = request.find(keyHeader);
    if (keyPos == std::string::npos) {
        return false;
    }

    size_t keyStart = keyPos + keyHeader.length();
    size_t keyEnd = request.find("\r\n", keyStart);
    std::string key = request.substr(keyStart, keyEnd - keyStart);

    // Generate accept key
    std::string acceptKey = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    constexpr size_t SHA1_DIGEST_LENGTH = 20;
    unsigned char hash[SHA1_DIGEST_LENGTH];
    sha1Hash(acceptKey, hash);

    std::string base64Accept = base64Encode(hash, SHA1_DIGEST_LENGTH);

    // Send handshake response
    std::ostringstream response;
    response << "HTTP/1.1 101 Switching Protocols\r\n";
    response << "Upgrade: websocket\r\n";
    response << "Connection: Upgrade\r\n";
    response << "Sec-WebSocket-Accept: " << base64Accept << "\r\n";
    response << "\r\n";

    std::string responseStr = response.str();
    send(clientSocket, responseStr.c_str(), responseStr.length(), 0);

    return true;
}

Request WebSocketServer::parseRequest(const std::string& jsonStr) {
    Request request;
    request.id = json::parseString(jsonStr, "id");
    request.type = json::parseString(jsonStr, "type");

    // Extract payload as JSON substring
    size_t payloadStart = jsonStr.find("\"payload\":");
    if (payloadStart != std::string::npos) {
        payloadStart += 10; // length of "\"payload\":"
        // Find matching end brace
        int braceCount = 0;
        size_t payloadEnd = payloadStart;
        for (size_t i = payloadStart; i < jsonStr.length(); i++) {
            if (jsonStr[i] == '{') braceCount++;
            else if (jsonStr[i] == '}') {
                braceCount--;
                if (braceCount == 0) {
                    payloadEnd = i + 1;
                    break;
                }
            }
        }
        request.payload = jsonStr.substr(payloadStart, payloadEnd - payloadStart);
    }

    return request;
}

// Simple JSON utilities
namespace json {

std::string stringify(const std::string& key, const std::string& value) {
    return "\"" + key + "\":\"" + value + "\"";
}

std::string stringify(const std::string& key, bool value) {
    return "\"" + key + "\":" + (value ? "true" : "false");
}

std::string stringify(const std::string& key, int value) {
    return "\"" + key + "\":" + std::to_string(value);
}

std::string stringify(const std::string& key, double value) {
    std::ostringstream oss;
    oss << std::setprecision(10) << value;
    return "\"" + key + "\":" + oss.str();
}

std::string parseString(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\":\"";
    size_t pos = json.find(search);
    if (pos == std::string::npos) {
        return "";
    }
    pos += search.length();

    // Find the closing quote, handling escaped quotes
    std::string result;
    bool escaped = false;
    for (size_t i = pos; i < json.size(); i++) {
        char c = json[i];
        if (escaped) {
            // Handle escape sequences
            switch (c) {
                case '"': result += '"'; break;
                case '\\': result += '\\'; break;
                case 'n': result += '\n'; break;
                case 'r': result += '\r'; break;
                case 't': result += '\t'; break;
                default: result += c; break;
            }
            escaped = false;
        } else if (c == '\\') {
            escaped = true;
        } else if (c == '"') {
            // End of string
            break;
        } else {
            result += c;
        }
    }
    return result;
}

bool parseBool(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\":";
    size_t pos = json.find(search);
    if (pos == std::string::npos) {
        return false;
    }
    pos += search.length();
    return json.substr(pos, 4) == "true";
}

int parseInt(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\":";
    size_t pos = json.find(search);
    if (pos == std::string::npos) {
        return 0;
    }
    pos += search.length();
    return std::stoi(json.substr(pos));
}

double parseDouble(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\":";
    size_t pos = json.find(search);
    if (pos == std::string::npos) {
        return 0.0;
    }
    pos += search.length();
    return std::stod(json.substr(pos));
}

} // namespace json

} // namespace ennio
