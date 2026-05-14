#pragma once

#include <string>

namespace ennio {

// Request envelope. Built by the CLI side as a JSON-RPC payload, hands
// off to HybridEnnio::handleCommand() inside a background dispatch
// worker. `payload` is a JSON string (not parsed) — the handler does
// its own type-specific extraction via cpp/json helpers.
struct Request {
    std::string id;
    std::string type;
    std::string payload;
};

// Response envelope. `data` is a pre-rendered JSON fragment (object,
// array, bool, number, string literal — whatever the handler emits).
// `Response::toJSON()` wraps it into the full reply object the CLI
// expects: `{"id":..,"success":..,"data":..,"error":..}`.
struct Response {
    std::string id;
    bool success;
    std::string data;
    std::string error;

    std::string toJSON() const;
};

// Tiny, dependency-free JSON helpers. Used by the dispatch handlers to
// peel typed values out of `Request.payload` (which is a JSON string,
// not a parsed object). Loose enough to handle the CLI's serialiser
// without pulling in a real JSON library; strict enough to break loudly
// if the wire format drifts.
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
