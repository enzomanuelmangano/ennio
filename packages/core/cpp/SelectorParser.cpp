#include "SelectorParser.hpp"
#include "EnnioLog.hpp"
#include <stdexcept>
#include <sstream>
#include <algorithm>
#include <cctype>

namespace ennio {

static const char* LOG_TAG = "SelectorParser";

namespace {
    // Helper to trim whitespace
    std::string trim(const std::string& str) {
        size_t start = str.find_first_not_of(" \t\n\r");
        if (start == std::string::npos) return "";
        size_t end = str.find_last_not_of(" \t\n\r");
        return str.substr(start, end - start + 1);
    }

    // Find matching bracket/brace
    size_t findMatchingBracket(const std::string& json, size_t start, char open, char close) {
        int depth = 1;
        bool inString = false;
        bool escaped = false;

        for (size_t i = start + 1; i < json.size(); i++) {
            char c = json[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (c == '\\') {
                escaped = true;
                continue;
            }

            if (c == '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (c == open) depth++;
                else if (c == close) {
                    depth--;
                    if (depth == 0) return i;
                }
            }
        }
        return std::string::npos;
    }

    // Locate `"key"` at the top level of the given JSON object. Skips
    // occurrences nested inside child objects or arrays — without this,
    // outer hasKey/extractString hits keys belonging to a nested
    // selector (e.g. `rightOf: {id: ...}` would leak its `id` into the
    // outer criteria.id and corrupt the match). Returns npos if absent.
    size_t findTopLevelKey(const std::string& json, const std::string& key) {
        std::string searchKey = "\"" + key + "\"";
        int depth = 0;
        bool inString = false;
        bool escaped = false;
        for (size_t i = 0; i < json.size(); i++) {
            char c = json[i];
            if (escaped) { escaped = false; continue; }
            if (inString) {
                if (c == '\\') { escaped = true; continue; }
                if (c == '"') { inString = false; }
                continue;
            }
            if (c == '"') {
                if (depth == 1 &&
                    json.compare(i, searchKey.size(), searchKey) == 0) {
                    // Confirm the next non-space char is ':' (key, not value).
                    size_t after = i + searchKey.size();
                    while (after < json.size() && std::isspace(json[after])) after++;
                    if (after < json.size() && json[after] == ':') {
                        return i;
                    }
                }
                inString = true;
                continue;
            }
            if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') depth--;
        }
        return std::string::npos;
    }

    // Escape string for JSON output
    std::string escapeString(const std::string& str) {
        std::ostringstream oss;
        for (char c : str) {
            switch (c) {
                case '"': oss << "\\\""; break;
                case '\\': oss << "\\\\"; break;
                case '\n': oss << "\\n"; break;
                case '\r': oss << "\\r"; break;
                case '\t': oss << "\\t"; break;
                default: oss << c;
            }
        }
        return oss.str();
    }
}

SelectorCriteria SelectorParser::parse(const std::string& json) {
    std::string trimmed = trim(json);

    if (trimmed.empty()) {
        throw std::runtime_error("Empty selector");
    }

    // Simple string selector (just testID)
    if (trimmed[0] == '"') {
        // Extract string value
        size_t end = trimmed.find('"', 1);
        if (end == std::string::npos) {
            throw std::runtime_error("Invalid selector: unterminated string");
        }
        std::string id = trimmed.substr(1, end - 1);
        return SelectorCriteria::fromId(id);
    }

    // Object selector
    if (trimmed[0] == '{') {
        return parseObject(trimmed);
    }

    // Plain string without quotes (legacy testID format)
    return SelectorCriteria::fromId(trimmed);
}

SelectorCriteria SelectorParser::parseObject(const std::string& json) {
    SelectorCriteria criteria;
    ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("parseObject: json=" << json));

    // Parse id
    if (hasKey(json, "id")) {
        criteria.id = extractString(json, "id");
        ENNIO_LOG_DEBUG(LOG_TAG, ENNIO_LOG_FMT("parseObject: id=" << *criteria.id));
    }

    // Parse text (can be string or object with pattern/mode)
    if (hasKey(json, "text")) {
        std::string textValue = extractString(json, "text");
        ENNIO_LOG_DEBUG(LOG_TAG, ENNIO_LOG_FMT("parseObject: text=" << textValue));
        TextMatchMode mode = TextMatchMode::Exact;

        // Check for textMatchMode
        if (hasKey(json, "textMatchMode")) {
            mode = parseTextMatchMode(extractString(json, "textMatchMode"));
        }

        criteria.text = TextMatcher{textValue, mode};
    }

    // Parse index
    auto indexOpt = extractNumber(json, "index");
    if (indexOpt) {
        criteria.index = static_cast<int>(*indexOpt);
    }

    // Parse point
    if (hasKey(json, "point")) {
        std::string pointStr = extractString(json, "point");
        if (!pointStr.empty()) {
            criteria.point = parsePoint(pointStr);
        } else {
            // Try object format
            std::string pointObj = extractObject(json, "point");
            if (!pointObj.empty()) {
                Point p;
                auto x = extractNumber(pointObj, "x");
                auto y = extractNumber(pointObj, "y");
                if (x) p.x = static_cast<float>(*x);
                if (y) p.y = static_cast<float>(*y);
                p.isPercentage = false;
                criteria.point = p;
            }
        }
    }

    // Parse state selectors
    criteria.enabled = extractBool(json, "enabled");
    criteria.checked = extractBool(json, "checked");
    criteria.focused = extractBool(json, "focused");
    criteria.selected = extractBool(json, "selected");

    // Parse spatial selectors
    criteria.below = parseNested(json, "below");
    criteria.above = parseNested(json, "above");
    criteria.leftOf = parseNested(json, "leftOf");
    criteria.rightOf = parseNested(json, "rightOf");

    // Parse hierarchical selectors
    criteria.containsChild = parseNested(json, "containsChild");
    criteria.childOf = parseNested(json, "childOf");

    // Parse containsDescendants array
    auto descendants = extractArray(json, "containsDescendants");
    for (const auto& desc : descendants) {
        auto parsed = std::make_shared<SelectorCriteria>(parse(desc));
        criteria.containsDescendants.push_back(parsed);
    }

    // Parse dimension selectors
    auto widthOpt = extractNumber(json, "width");
    if (widthOpt) {
        criteria.width = static_cast<float>(*widthOpt);
    }

    auto heightOpt = extractNumber(json, "height");
    if (heightOpt) {
        criteria.height = static_cast<float>(*heightOpt);
    }

    auto toleranceOpt = extractNumber(json, "tolerance");
    if (toleranceOpt) {
        criteria.tolerance = static_cast<float>(*toleranceOpt);
    }

    // Parse traits array
    auto traitsArray = extractArray(json, "traits");
    for (const auto& trait : traitsArray) {
        std::string t = trim(trait);
        // Remove quotes if present
        if (t.size() >= 2 && t[0] == '"') {
            t = t.substr(1, t.size() - 2);
        }
        criteria.traits.push_back(parseTrait(t));
    }

    return criteria;
}

SelectorCriteriaPtr SelectorParser::parseNested(const std::string& json, const std::string& key) {
    std::string nested = extractObject(json, key);
    if (nested.empty()) {
        return nullptr;
    }
    return std::make_shared<SelectorCriteria>(parse(nested));
}

std::string SelectorParser::extractString(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = findTopLevelKey(json, key);
    if (keyPos == std::string::npos) {
        return "";
    }

    size_t colonPos = json.find(':', keyPos + searchKey.size());
    if (colonPos == std::string::npos) {
        return "";
    }

    // Find the value start
    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && std::isspace(json[valueStart])) {
        valueStart++;
    }

    if (valueStart >= json.size()) {
        return "";
    }

    // If it's a string value, parse with proper escape handling
    if (json[valueStart] == '"') {
        std::string result;
        bool escaped = false;
        for (size_t i = valueStart + 1; i < json.size(); i++) {
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

    return "";
}

std::optional<bool> SelectorParser::extractBool(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = findTopLevelKey(json, key);
    if (keyPos == std::string::npos) {
        return std::nullopt;
    }

    size_t colonPos = json.find(':', keyPos + searchKey.size());
    if (colonPos == std::string::npos) {
        return std::nullopt;
    }

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && std::isspace(json[valueStart])) {
        valueStart++;
    }

    if (json.compare(valueStart, 4, "true") == 0) {
        return true;
    }
    if (json.compare(valueStart, 5, "false") == 0) {
        return false;
    }

    return std::nullopt;
}

std::optional<double> SelectorParser::extractNumber(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = findTopLevelKey(json, key);
    if (keyPos == std::string::npos) {
        return std::nullopt;
    }

    size_t colonPos = json.find(':', keyPos + searchKey.size());
    if (colonPos == std::string::npos) {
        return std::nullopt;
    }

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && std::isspace(json[valueStart])) {
        valueStart++;
    }

    // Check if it's a number
    if (valueStart < json.size() && (std::isdigit(json[valueStart]) || json[valueStart] == '-' || json[valueStart] == '.')) {
        size_t valueEnd = valueStart;
        while (valueEnd < json.size() && (std::isdigit(json[valueEnd]) || json[valueEnd] == '.' || json[valueEnd] == '-' || json[valueEnd] == 'e' || json[valueEnd] == 'E')) {
            valueEnd++;
        }
        std::string numStr = json.substr(valueStart, valueEnd - valueStart);
        try {
            return std::stod(numStr);
        } catch (...) {
            return std::nullopt;
        }
    }

    return std::nullopt;
}

std::string SelectorParser::extractObject(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = findTopLevelKey(json, key);
    if (keyPos == std::string::npos) {
        return "";
    }

    size_t colonPos = json.find(':', keyPos + searchKey.size());
    if (colonPos == std::string::npos) {
        return "";
    }

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && std::isspace(json[valueStart])) {
        valueStart++;
    }

    if (valueStart >= json.size() || json[valueStart] != '{') {
        return "";
    }

    size_t valueEnd = findMatchingBracket(json, valueStart, '{', '}');
    if (valueEnd == std::string::npos) {
        return "";
    }

    return json.substr(valueStart, valueEnd - valueStart + 1);
}

std::vector<std::string> SelectorParser::extractArray(const std::string& json, const std::string& key) {
    std::vector<std::string> result;

    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = findTopLevelKey(json, key);
    if (keyPos == std::string::npos) {
        return result;
    }

    size_t colonPos = json.find(':', keyPos + searchKey.size());
    if (colonPos == std::string::npos) {
        return result;
    }

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && std::isspace(json[valueStart])) {
        valueStart++;
    }

    if (valueStart >= json.size() || json[valueStart] != '[') {
        return result;
    }

    size_t arrayEnd = findMatchingBracket(json, valueStart, '[', ']');
    if (arrayEnd == std::string::npos) {
        return result;
    }

    // Parse array elements
    size_t pos = valueStart + 1;
    while (pos < arrayEnd) {
        // Skip whitespace
        while (pos < arrayEnd && std::isspace(json[pos])) pos++;
        if (pos >= arrayEnd) break;

        // Skip comma
        if (json[pos] == ',') {
            pos++;
            continue;
        }

        // Parse element
        if (json[pos] == '{') {
            size_t end = findMatchingBracket(json, pos, '{', '}');
            if (end != std::string::npos) {
                result.push_back(json.substr(pos, end - pos + 1));
                pos = end + 1;
            } else {
                break;
            }
        } else if (json[pos] == '"') {
            size_t end = pos + 1;
            while (end < arrayEnd && !(json[end] == '"' && json[end - 1] != '\\')) {
                end++;
            }
            result.push_back(json.substr(pos, end - pos + 1));
            pos = end + 1;
        } else {
            // Skip to next comma or end
            size_t end = pos;
            while (end < arrayEnd && json[end] != ',' && json[end] != ']') {
                end++;
            }
            std::string element = trim(json.substr(pos, end - pos));
            if (!element.empty()) {
                result.push_back(element);
            }
            pos = end;
        }
    }

    return result;
}

bool SelectorParser::hasKey(const std::string& json, const std::string& key) {
    return findTopLevelKey(json, key) != std::string::npos;
}

TextMatchMode SelectorParser::parseTextMatchMode(const std::string& mode) {
    if (mode == "contains") return TextMatchMode::Contains;
    if (mode == "regex") return TextMatchMode::Regex;
    if (mode == "startsWith") return TextMatchMode::StartsWith;
    if (mode == "endsWith") return TextMatchMode::EndsWith;
    return TextMatchMode::Exact;
}

Trait SelectorParser::parseTrait(const std::string& trait) {
    if (trait == "long-text" || trait == "longText") return Trait::LongText;
    if (trait == "square") return Trait::Square;
    return Trait::Text; // default
}

Point SelectorParser::parsePoint(const std::string& value) {
    Point point{0, 0, false};

    // Check if percentage format: "50%,50%"
    if (value.find('%') != std::string::npos) {
        point.isPercentage = true;
        size_t comma = value.find(',');
        if (comma != std::string::npos) {
            std::string xStr = value.substr(0, comma);
            std::string yStr = value.substr(comma + 1);

            // Remove % signs
            xStr.erase(std::remove(xStr.begin(), xStr.end(), '%'), xStr.end());
            yStr.erase(std::remove(yStr.begin(), yStr.end(), '%'), yStr.end());

            try {
                point.x = std::stof(trim(xStr));
                point.y = std::stof(trim(yStr));
            } catch (...) {}
        }
    } else {
        // Absolute format: "100,200"
        size_t comma = value.find(',');
        if (comma != std::string::npos) {
            try {
                point.x = std::stof(trim(value.substr(0, comma)));
                point.y = std::stof(trim(value.substr(comma + 1)));
            } catch (...) {}
        }
    }

    return point;
}

std::string SelectorParser::toJSON(const SelectorCriteria& criteria) {
    std::ostringstream oss;
    oss << "{";

    bool first = true;
    auto addComma = [&]() {
        if (!first) oss << ",";
        first = false;
    };

    if (criteria.id) {
        addComma();
        oss << "\"id\":\"" << escapeString(*criteria.id) << "\"";
    }

    if (criteria.text) {
        addComma();
        oss << "\"text\":\"" << escapeString(criteria.text->pattern) << "\"";
        if (criteria.text->mode != TextMatchMode::Exact) {
            oss << ",\"textMatchMode\":\"";
            switch (criteria.text->mode) {
                case TextMatchMode::Contains: oss << "contains"; break;
                case TextMatchMode::Regex: oss << "regex"; break;
                case TextMatchMode::StartsWith: oss << "startsWith"; break;
                case TextMatchMode::EndsWith: oss << "endsWith"; break;
                default: oss << "exact";
            }
            oss << "\"";
        }
    }

    if (criteria.index) {
        addComma();
        oss << "\"index\":" << *criteria.index;
    }

    if (criteria.enabled) {
        addComma();
        oss << "\"enabled\":" << (*criteria.enabled ? "true" : "false");
    }

    if (criteria.checked) {
        addComma();
        oss << "\"checked\":" << (*criteria.checked ? "true" : "false");
    }

    if (criteria.focused) {
        addComma();
        oss << "\"focused\":" << (*criteria.focused ? "true" : "false");
    }

    if (criteria.selected) {
        addComma();
        oss << "\"selected\":" << (*criteria.selected ? "true" : "false");
    }

    if (criteria.below) {
        addComma();
        oss << "\"below\":" << toJSON(*criteria.below);
    }

    if (criteria.above) {
        addComma();
        oss << "\"above\":" << toJSON(*criteria.above);
    }

    if (criteria.leftOf) {
        addComma();
        oss << "\"leftOf\":" << toJSON(*criteria.leftOf);
    }

    if (criteria.rightOf) {
        addComma();
        oss << "\"rightOf\":" << toJSON(*criteria.rightOf);
    }

    if (criteria.containsChild) {
        addComma();
        oss << "\"containsChild\":" << toJSON(*criteria.containsChild);
    }

    if (criteria.childOf) {
        addComma();
        oss << "\"childOf\":" << toJSON(*criteria.childOf);
    }

    if (!criteria.containsDescendants.empty()) {
        addComma();
        oss << "\"containsDescendants\":[";
        for (size_t i = 0; i < criteria.containsDescendants.size(); i++) {
            if (i > 0) oss << ",";
            oss << toJSON(*criteria.containsDescendants[i]);
        }
        oss << "]";
    }

    if (criteria.width) {
        addComma();
        oss << "\"width\":" << *criteria.width;
    }

    if (criteria.height) {
        addComma();
        oss << "\"height\":" << *criteria.height;
    }

    if (criteria.tolerance) {
        addComma();
        oss << "\"tolerance\":" << *criteria.tolerance;
    }

    if (!criteria.traits.empty()) {
        addComma();
        oss << "\"traits\":[";
        for (size_t i = 0; i < criteria.traits.size(); i++) {
            if (i > 0) oss << ",";
            oss << "\"";
            switch (criteria.traits[i]) {
                case Trait::Text: oss << "text"; break;
                case Trait::LongText: oss << "long-text"; break;
                case Trait::Square: oss << "square"; break;
            }
            oss << "\"";
        }
        oss << "]";
    }

    oss << "}";
    return oss.str();
}

} // namespace ennio
