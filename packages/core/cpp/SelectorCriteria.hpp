#pragma once

#include <memory>
#include <optional>
#include <regex>
#include <string>
#include <vector>

namespace tasto {

/**
 * Text matching mode for text selectors
 */
enum class TextMatchMode {
    Exact,      // Exact match
    Contains,   // Contains substring
    Regex,      // Regular expression
    StartsWith, // Starts with prefix
    EndsWith    // Ends with suffix
};

/**
 * Text matcher configuration
 */
struct TextMatcher {
    std::string pattern;
    TextMatchMode mode = TextMatchMode::Exact;

    /**
     * Check if the given text matches this matcher
     */
    bool matches(const std::string& text) const {
        switch (mode) {
            case TextMatchMode::Exact:
                return text == pattern;
            case TextMatchMode::Contains:
                return text.find(pattern) != std::string::npos;
            case TextMatchMode::StartsWith:
                return text.size() >= pattern.size() &&
                       text.compare(0, pattern.size(), pattern) == 0;
            case TextMatchMode::EndsWith:
                return text.size() >= pattern.size() &&
                       text.compare(text.size() - pattern.size(), pattern.size(), pattern) == 0;
            case TextMatchMode::Regex:
                try {
                    std::regex re(pattern);
                    return std::regex_search(text, re);
                } catch (...) {
                    return false;
                }
        }
        return false;
    }
};

/**
 * Point for coordinate-based selection
 */
struct Point {
    float x;
    float y;
    bool isPercentage = false; // If true, x/y are percentages (0-100)
};

/**
 * Supported trait types for trait-based selection
 */
enum class Trait {
    Text,       // Element has text content
    LongText,   // Element has 200+ characters
    Square      // Element width ≈ height (within 10%)
};

// Forward declaration for recursive selectors
struct SelectorCriteria;

/**
 * Shared pointer to SelectorCriteria for recursive references
 */
using SelectorCriteriaPtr = std::shared_ptr<SelectorCriteria>;

/**
 * SelectorCriteria - Complete Maestro selector parity
 *
 * Supports:
 * - Primary: id, text, index, point
 * - State: enabled, checked, focused, selected
 * - Spatial: below, above, leftOf, rightOf
 * - Hierarchical: containsChild, childOf, containsDescendants
 * - Dimensions: width, height, tolerance
 * - Traits: text, long-text, square
 */
struct SelectorCriteria {
    // ============================================
    // Primary Selectors
    // ============================================

    /**
     * Match by testID (O(1) lookup when used alone)
     */
    std::optional<std::string> id;

    /**
     * Match by text content
     */
    std::optional<TextMatcher> text;

    /**
     * Return the nth matching element (0-indexed)
     */
    std::optional<int> index;

    /**
     * Select element at specific coordinates
     */
    std::optional<Point> point;

    // ============================================
    // State Selectors
    // ============================================

    /**
     * Match by enabled state
     */
    std::optional<bool> enabled;

    /**
     * Match by checked state (checkboxes, switches)
     */
    std::optional<bool> checked;

    /**
     * Match by focused state
     */
    std::optional<bool> focused;

    /**
     * Match by selected state
     */
    std::optional<bool> selected;

    // ============================================
    // Spatial Selectors (relative positioning)
    // ============================================

    /**
     * Match elements below the reference element
     */
    SelectorCriteriaPtr below;

    /**
     * Match elements above the reference element
     */
    SelectorCriteriaPtr above;

    /**
     * Match elements to the left of the reference element
     */
    SelectorCriteriaPtr leftOf;

    /**
     * Match elements to the right of the reference element
     */
    SelectorCriteriaPtr rightOf;

    // ============================================
    // Hierarchical Selectors
    // ============================================

    /**
     * Match elements that contain a direct child matching criteria
     */
    SelectorCriteriaPtr containsChild;

    /**
     * Match elements that are children of an element matching criteria
     */
    SelectorCriteriaPtr childOf;

    /**
     * Match elements that contain all descendants matching each criteria
     */
    std::vector<SelectorCriteriaPtr> containsDescendants;

    // ============================================
    // Dimension Selectors
    // ============================================

    /**
     * Match by width (in points)
     */
    std::optional<float> width;

    /**
     * Match by height (in points)
     */
    std::optional<float> height;

    /**
     * Tolerance for width/height matching (default: 0)
     */
    std::optional<float> tolerance;

    // ============================================
    // Trait Selectors
    // ============================================

    /**
     * Match elements with specified traits
     */
    std::vector<Trait> traits;

    // ============================================
    // Helpers
    // ============================================

    /**
     * Check if this is an id-only selector (fast path)
     */
    bool isIdOnly() const {
        return id.has_value() &&
               !text.has_value() &&
               !index.has_value() &&
               !point.has_value() &&
               !enabled.has_value() &&
               !checked.has_value() &&
               !focused.has_value() &&
               !selected.has_value() &&
               !below &&
               !above &&
               !leftOf &&
               !rightOf &&
               !containsChild &&
               !childOf &&
               containsDescendants.empty() &&
               !width.has_value() &&
               !height.has_value() &&
               traits.empty();
    }

    /**
     * Check if any spatial selectors are used
     */
    bool hasSpatialCriteria() const {
        return below || above || leftOf || rightOf;
    }

    /**
     * Check if any hierarchical selectors are used
     */
    bool hasHierarchicalCriteria() const {
        return containsChild || childOf || !containsDescendants.empty();
    }

    /**
     * Check if any dimension selectors are used
     */
    bool hasDimensionCriteria() const {
        return width.has_value() || height.has_value();
    }

    /**
     * Create an id-only selector (convenience factory)
     */
    static SelectorCriteria fromId(const std::string& testID) {
        SelectorCriteria criteria;
        criteria.id = testID;
        return criteria;
    }

    /**
     * Create a text selector (convenience factory)
     */
    static SelectorCriteria fromText(const std::string& textContent, TextMatchMode mode = TextMatchMode::Exact) {
        SelectorCriteria criteria;
        criteria.text = TextMatcher{textContent, mode};
        return criteria;
    }
};

} // namespace tasto
