#pragma once

#include "SelectorCriteria.hpp"
#include "ShadowTreeTraverser.hpp"
#include "TestIDRegistry.hpp"

#include <memory>
#include <optional>
#include <regex>
#include <string>
#include <vector>

#include <react/renderer/core/ShadowNode.h>

namespace ennio {

/**
 * Extended element info with additional state properties
 */
struct ExtendedElementInfo : public ElementInfo {
    bool checked = false;
    bool focused = false;
    bool selected = false;

    // Parent tracking for childOf queries
    const facebook::react::ShadowNode* parent = nullptr;
};

/**
 * ElementMatcher - Multi-criteria element matching engine
 *
 * Optimized matching with:
 * - O(1) fast path for id-only selectors via TestIDRegistry
 * - Efficient spatial matching using pre-computed reference positions
 * - Parent chain tracking for hierarchical queries
 */
class ElementMatcher {
public:
    using ShadowNodePtr = std::shared_ptr<const facebook::react::ShadowNode>;

    /**
     * Find the first element matching the criteria
     *
     * @param root - Shadow tree root
     * @param criteria - Selection criteria
     * @return Matching node or nullptr
     */
    static ShadowNodePtr findFirst(
        ShadowNodePtr root,
        const SelectorCriteria& criteria
    );

    /**
     * Find all elements matching the criteria
     *
     * @param root - Shadow tree root
     * @param criteria - Selection criteria
     * @return Vector of matching nodes
     */
    static std::vector<ShadowNodePtr> findAll(
        ShadowNodePtr root,
        const SelectorCriteria& criteria
    );

    /**
     * Get extended element info including state properties
     */
    static std::optional<ExtendedElementInfo> getExtendedElementInfo(
        ShadowNodePtr root,
        ShadowNodePtr node
    );

private:
    /**
     * Context for matching operations
     */
    struct MatchContext {
        ShadowNodePtr root;
        float screenWidth = 430.0f;
        float screenHeight = 932.0f;

        // Resolved reference elements for spatial queries
        std::optional<LayoutMetrics> belowRef;
        std::optional<LayoutMetrics> aboveRef;
        std::optional<LayoutMetrics> leftOfRef;
        std::optional<LayoutMetrics> rightOfRef;

        // Parent tracking
        std::vector<const facebook::react::ShadowNode*> parentChain;
    };

    /**
     * Resolve spatial reference elements
     */
    static void resolveSpatialRefs(
        const SelectorCriteria& criteria,
        MatchContext& ctx
    );

    /**
     * Check if a node matches all criteria
     */
    static bool matches(
        ShadowNodePtr node,
        const SelectorCriteria& criteria,
        const MatchContext& ctx
    );

    /**
     * Match primary criteria (id, text, point)
     */
    static bool matchesPrimary(
        ShadowNodePtr node,
        const SelectorCriteria& criteria
    );

    /**
     * Match text with different modes
     */
    static bool matchesText(
        const std::string& actual,
        const TextMatcher& matcher
    );

    /**
     * Match state criteria (enabled, checked, focused, selected)
     */
    static bool matchesState(
        ShadowNodePtr node,
        const SelectorCriteria& criteria
    );

    /**
     * Match spatial criteria (below, above, leftOf, rightOf)
     */
    static bool matchesSpatial(
        ShadowNodePtr node,
        const LayoutMetrics& nodeMetrics,
        const MatchContext& ctx
    );

    /**
     * Check if candidate is below reference
     */
    static bool isBelow(const LayoutMetrics& candidate, const LayoutMetrics& reference);

    /**
     * Check if candidate is above reference
     */
    static bool isAbove(const LayoutMetrics& candidate, const LayoutMetrics& reference);

    /**
     * Check if candidate is left of reference
     */
    static bool isLeftOf(const LayoutMetrics& candidate, const LayoutMetrics& reference);

    /**
     * Check if candidate is right of reference
     */
    static bool isRightOf(const LayoutMetrics& candidate, const LayoutMetrics& reference);

    /**
     * Match hierarchical criteria (containsChild, childOf, containsDescendants)
     */
    static bool matchesHierarchical(
        ShadowNodePtr node,
        const SelectorCriteria& criteria,
        const MatchContext& ctx
    );

    /**
     * Check if node contains a direct child matching criteria
     */
    static bool containsChild(
        ShadowNodePtr node,
        const SelectorCriteria& criteria,
        const MatchContext& ctx
    );

    /**
     * Check if node is a child of an element matching criteria
     */
    static bool isChildOf(
        const std::vector<const facebook::react::ShadowNode*>& parentChain,
        const SelectorCriteria& criteria,
        const MatchContext& ctx
    );

    /**
     * Check if node contains all descendants matching each criteria
     */
    static bool containsDescendants(
        ShadowNodePtr node,
        const std::vector<SelectorCriteriaPtr>& criteria,
        const MatchContext& ctx
    );

    /**
     * Match dimension criteria (width, height with tolerance)
     */
    static bool matchesDimensions(
        const LayoutMetrics& metrics,
        const SelectorCriteria& criteria
    );

    /**
     * Match trait criteria
     */
    static bool matchesTraits(
        ShadowNodePtr node,
        const LayoutMetrics& metrics,
        const std::vector<Trait>& traits
    );

    /**
     * Get the layout metrics for a node
     */
    static std::optional<LayoutMetrics> getNodeMetrics(
        ShadowNodePtr root,
        ShadowNodePtr node
    );

    /**
     * Extract state properties from node props
     */
    static void extractStateProps(
        ShadowNodePtr node,
        bool& outChecked,
        bool& outFocused,
        bool& outSelected
    );

    /**
     * Collect all matching nodes via tree traversal
     */
    static void collectMatches(
        ShadowNodePtr node,
        const SelectorCriteria& criteria,
        MatchContext& ctx,
        std::vector<ShadowNodePtr>& results
    );
};

} // namespace ennio
