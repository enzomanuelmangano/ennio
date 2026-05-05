#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ennio {

/**
 * Request from the test runner
 */
struct Request {
    std::string id;
    std::string type;
    std::string payload; // JSON string
};

/**
 * Response to send back to the test runner
 */
struct Response {
    std::string id;
    bool success;
    std::string data; // JSON string (optional)
    std::string error; // Error message (optional)

    std::string toJSON() const;
};

/**
 * Command handler callback type
 */
using CommandHandler = std::function<Response(const Request&)>;

/**
 * WebSocketServer provides a native TCP WebSocket server
 * for communication with the Node.js test runner.
 *
 * Protocol:
 * - JSON messages over WebSocket
 * - Request: { "id": "uuid", "type": "command", "payload": {...} }
 * - Response: { "id": "uuid", "success": bool, "data": {...}, "error": "msg" }
 */
class WebSocketServer {
public:
    WebSocketServer();
    ~WebSocketServer();

    // Prevent copying
    WebSocketServer(const WebSocketServer&) = delete;
    WebSocketServer& operator=(const WebSocketServer&) = delete;

    /**
     * Start the server on the specified port
     * @param port - Port number to listen on
     * @returns true if server started successfully
     */
    bool start(int port);

    /**
     * Stop the server
     */
    void stop();

    /**
     * Check if server is running
     */
    bool isRunning() const;

    /**
     * Get the current port
     */
    int getPort() const;

    /**
     * Set the command handler
     * This callback is invoked for each incoming command
     */
    void setCommandHandler(CommandHandler handler);

    /**
     * Send a response to a specific client
     */
    void sendResponse(int clientId, const Response& response);

    /**
     * Broadcast a message to all connected clients
     */
    void broadcast(const std::string& message);

    /**
     * Get number of connected clients
     */
    int getClientCount() const;

private:
    /**
     * Server loop running on dedicated thread
     */
    void serverLoop();

    /**
     * Handle a new client connection
     */
    void handleClient(int clientSocket);

    /**
     * Parse a WebSocket frame
     */
    std::string parseFrame(const std::vector<uint8_t>& data);

    /**
     * Build a WebSocket frame
     */
    std::vector<uint8_t> buildFrame(const std::string& message);

    /**
     * Perform WebSocket handshake
     */
    bool performHandshake(int clientSocket);

    /**
     * Parse incoming request JSON
     */
    Request parseRequest(const std::string& json);

    int port_;
    int serverSocket_;
    std::atomic<bool> running_;
    std::thread serverThread_;
    CommandHandler commandHandler_;
    mutable std::mutex mutex_;
    std::vector<int> clients_;
};

/**
 * Utility functions for JSON serialization
 * Using a simple implementation to avoid external dependencies
 */
namespace json {
    std::string stringify(const std::string& key, const std::string& value);
    std::string stringify(const std::string& key, bool value);
    std::string stringify(const std::string& key, int value);
    std::string stringify(const std::string& key, double value);

    std::string parseString(const std::string& json, const std::string& key);
    bool parseBool(const std::string& json, const std::string& key);
    int parseInt(const std::string& json, const std::string& key);
    double parseDouble(const std::string& json, const std::string& key);
}

} // namespace ennio
