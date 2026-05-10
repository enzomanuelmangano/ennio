#pragma once

#include "SelectorCriteria.hpp"
#include <string>

namespace ennio {

/**
 * SelectorParser - Parse JSON selector strings into SelectorCriteria
 *
 * Supports the full Maestro selector syntax:
 * - Simple string: "my-test-id" -> id-only selector
 * - Object: { "id": "btn", "text": "Submit", "enabled": true }
 * - Nested: { "text": "OK", "below": { "id": "title" } }
 */
class SelectorParser {
public:
    /**
     * Parse a JSON selector string into SelectorCriteria
     *
     * @param json - JSON string representing the selector
     * @return Parsed SelectorCriteria
     * @throws std::runtime_error if parsing fails
     *
     * Examples:
     *   "my-test-id" -> { id: "my-test-id" }
     *   { "text": "Login" } -> { text: { pattern: "Login", mode: Exact } }
     *   { "text": ".*Login.*", "textMatchMode": "regex" } -> regex match
     */
    static SelectorCriteria parse(const std::string& json);

    /**
     * Serialize SelectorCriteria back to JSON string
     */
    static std::string toJSON(const SelectorCriteria& criteria);

private:
    /**
     * Parse a JSON object into SelectorCriteria
     */
    static SelectorCriteria parseObject(const std::string& json);

    /**
     * Parse a nested selector (for spatial/hierarchical refs)
     */
    static SelectorCriteriaPtr parseNested(const std::string& json, const std::string& key);

    /**
     * Extract string value from JSON
     */
    static std::string extractString(const std::string& json, const std::string& key);

    /**
     * Extract boolean value from JSON
     */
    static std::optional<bool> extractBool(const std::string& json, const std::string& key);

    /**
     * Extract number value from JSON
     */
    static std::optional<double> extractNumber(const std::string& json, const std::string& key);

    /**
     * Extract nested object as JSON string
     */
    static std::string extractObject(const std::string& json, const std::string& key);

    /**
     * Extract array as vector of JSON strings
     */
    static std::vector<std::string> extractArray(const std::string& json, const std::string& key);

    /**
     * Check if key exists in JSON
     */
    static bool hasKey(const std::string& json, const std::string& key);

    /**
     * Parse TextMatchMode from string
     */
    static TextMatchMode parseTextMatchMode(const std::string& mode);

    /**
     * Parse Trait from string
     */
    static Trait parseTrait(const std::string& trait);

    /**
     * Parse Point from string or object
     */
    static Point parsePoint(const std::string& value);
};

} // namespace ennio
