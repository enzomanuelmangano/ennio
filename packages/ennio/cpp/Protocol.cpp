#include "Protocol.hpp"

#include <iomanip>
#include <sstream>
#include <string>

namespace ennio {

// Escape characters that would otherwise break the toJSON() string when
// `id` or `error` carries an external value (request id, exception
// message). Control chars get \uXXXX form, the rest match the strict
// JSON escape set.
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
    std::string result;
    bool escaped = false;
    for (size_t i = pos; i < json.size(); i++) {
        char c = json[i];
        if (escaped) {
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

} // namespace ennio
