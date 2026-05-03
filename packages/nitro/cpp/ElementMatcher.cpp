#include "ElementMatcher.hpp"

#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/LayoutableShadowNode.h>

#include <cmath>

// Logging for ElementMatcher
#ifdef __APPLE__
extern "C" void TastoLogMessage(const char* message);
#define EM_LOG(fmt, ...) do { char buf[512]; snprintf(buf, sizeof(buf), "[Tasto EM] " fmt, ##__VA_ARGS__); TastoLogMessage(buf); } while(0)
#else
#define EM_LOG(fmt, ...) ((void)0)
#endif

namespace tasto {

// Helper to check if a node is likely a button (interactive element)
static bool isLikelyButton(const ShadowTreeTraverser::ShadowNodePtr& node) {
    if (!node) return false;

    // Check ViewProps for accessibility traits
    auto viewProps = std::dynamic_pointer_cast<const facebook::react::ViewProps>(
        node->getProps()
    );

    if (viewProps) {
        // Check accessibility role
        auto role = viewProps->accessibilityRole;
        if (role == "button" || role == "link" || role == "tab") {
            return true;
        }

        // Check if accessible (buttons are usually accessible)
        if (viewProps->accessible) {
            return true;
        }
    }

    return false;
}

ShadowTreeTraverser::ShadowNodePtr ElementMatcher::findFirst(
    ShadowNodePtr root,
    const SelectorCriteria& criteria
) {
    EM_LOG("findFirst: START");
    if (!root) {
        EM_LOG("findFirst: no root");
        return nullptr;
    }

    // Fast path: id-only selector -> O(1) registry lookup
    if (criteria.isIdOnly() && criteria.id) {
        EM_LOG("findFirst: id-only fast path, id=%s", criteria.id->c_str());
        auto& registry = TestIDRegistry::getInstance();
        auto node = registry.findByTestID(*criteria.id);
        if (node) {
            EM_LOG("findFirst: found in registry");
            return node;
        }
        // Fallback to tree search
        EM_LOG("findFirst: fallback to tree search");
        return ShadowTreeTraverser::findByTestID(root, *criteria.id);
    }

    // Complex selector: tree traversal with matching
    EM_LOG("findFirst: complex selector, calling findAll");
    auto results = findAll(root, criteria);
    EM_LOG("findFirst: findAll returned %zu results", results.size());

    // Apply index if specified
    if (criteria.index) {
        int idx = *criteria.index;
        if (idx >= 0 && idx < static_cast<int>(results.size())) {
            EM_LOG("findFirst: returning indexed result");
            return results[idx];
        }
        EM_LOG("findFirst: index out of bounds");
        return nullptr;
    }

    if (results.empty()) {
        EM_LOG("findFirst: END returning null");
        return nullptr;
    }

    // For text selectors with multiple matches, prefer interactive elements (buttons)
    if (criteria.text && results.size() > 1) {
        EM_LOG("findFirst: text selector with %zu matches, looking for buttons", results.size());
        for (const auto& node : results) {
            if (isLikelyButton(node)) {
                EM_LOG("findFirst: found button match");
                return node;
            }
        }
        // No button found, fall back to first match
        EM_LOG("findFirst: no button found, using first match");
    }

    EM_LOG("findFirst: END returning first result");
    return results[0];
}

std::vector<ShadowTreeTraverser::ShadowNodePtr> ElementMatcher::findAll(
    ShadowNodePtr root,
    const SelectorCriteria& criteria
) {
    std::vector<ShadowNodePtr> results;

    if (!root) {
        return results;
    }

    // Initialize match context
    MatchContext ctx;
    ctx.root = root;

    // Resolve spatial reference elements
    resolveSpatialRefs(criteria, ctx);

    // Traverse tree and collect matches
    collectMatches(root, criteria, ctx, results);

    return results;
}

std::optional<ExtendedElementInfo> ElementMatcher::getExtendedElementInfo(
    ShadowNodePtr root,
    ShadowNodePtr node
) {
    auto baseInfo = ShadowTreeTraverser::getElementInfo(node);
    if (!baseInfo) {
        return std::nullopt;
    }

    ExtendedElementInfo info;
    // Copy base info
    info.testID = baseInfo->testID;
    info.type = baseInfo->type;
    info.text = baseInfo->text;
    info.accessible = baseInfo->accessible;
    info.enabled = baseInfo->enabled;
    info.layout = baseInfo->layout;

    // Extract additional state props
    extractStateProps(node, info.checked, info.focused, info.selected);

    return info;
}

void ElementMatcher::resolveSpatialRefs(
    const SelectorCriteria& criteria,
    MatchContext& ctx
) {
    // Resolve 'below' reference
    if (criteria.below) {
        auto refNode = findFirst(ctx.root, *criteria.below);
        if (refNode) {
            ctx.belowRef = getNodeMetrics(ctx.root, refNode);
        }
    }

    // Resolve 'above' reference
    if (criteria.above) {
        auto refNode = findFirst(ctx.root, *criteria.above);
        if (refNode) {
            ctx.aboveRef = getNodeMetrics(ctx.root, refNode);
        }
    }

    // Resolve 'leftOf' reference
    if (criteria.leftOf) {
        auto refNode = findFirst(ctx.root, *criteria.leftOf);
        if (refNode) {
            ctx.leftOfRef = getNodeMetrics(ctx.root, refNode);
        }
    }

    // Resolve 'rightOf' reference
    if (criteria.rightOf) {
        auto refNode = findFirst(ctx.root, *criteria.rightOf);
        if (refNode) {
            ctx.rightOfRef = getNodeMetrics(ctx.root, refNode);
        }
    }
}

bool ElementMatcher::matches(
    ShadowNodePtr node,
    const SelectorCriteria& criteria,
    const MatchContext& ctx
) {
    if (!node) {
        return false;
    }

    // Check primary criteria
    if (!matchesPrimary(node, criteria)) {
        return false;
    }

    // Check state criteria
    if (!matchesState(node, criteria)) {
        return false;
    }

    // Get metrics for spatial/dimension checks
    auto metrics = getNodeMetrics(ctx.root, node);

    // Check spatial criteria (if refs resolved)
    if (criteria.hasSpatialCriteria()) {
        if (!metrics) {
            return false;
        }
        if (!matchesSpatial(node, *metrics, ctx)) {
            return false;
        }
    }

    // Check hierarchical criteria
    if (criteria.hasHierarchicalCriteria()) {
        if (!matchesHierarchical(node, criteria, ctx)) {
            return false;
        }
    }

    // Check dimension criteria
    if (criteria.hasDimensionCriteria()) {
        if (!metrics) {
            return false;
        }
        if (!matchesDimensions(*metrics, criteria)) {
            return false;
        }
    }

    // Check trait criteria
    if (!criteria.traits.empty()) {
        if (!metrics) {
            return false;
        }
        if (!matchesTraits(node, *metrics, criteria.traits)) {
            return false;
        }
    }

    return true;
}

bool ElementMatcher::matchesPrimary(
    ShadowNodePtr node,
    const SelectorCriteria& criteria
) {
    // Match id
    if (criteria.id) {
        auto nodeTestID = ShadowTreeTraverser::getTestID(*node);
        if (!nodeTestID || *nodeTestID != *criteria.id) {
            return false;
        }
    }

    // Match text
    if (criteria.text) {
        auto nodeText = ShadowTreeTraverser::getText(node);
        if (!nodeText) {
            return false;
        }
        if (!matchesText(*nodeText, *criteria.text)) {
            return false;
        }
        // Debug: log matched text
        EM_LOG("matchesPrimary: text match! pattern='%s' nodeText='%.50s'",
            criteria.text->pattern.c_str(), nodeText->c_str());
    }

    // Point matching is handled separately (coordinate-based selection)

    return true;
}

bool ElementMatcher::matchesText(
    const std::string& actual,
    const TextMatcher& matcher
) {
    switch (matcher.mode) {
        case TextMatchMode::Exact:
            return actual == matcher.pattern;

        case TextMatchMode::Contains:
            return actual.find(matcher.pattern) != std::string::npos;

        case TextMatchMode::StartsWith:
            return actual.size() >= matcher.pattern.size() &&
                   actual.compare(0, matcher.pattern.size(), matcher.pattern) == 0;

        case TextMatchMode::EndsWith:
            return actual.size() >= matcher.pattern.size() &&
                   actual.compare(actual.size() - matcher.pattern.size(),
                                 matcher.pattern.size(), matcher.pattern) == 0;

        case TextMatchMode::Regex:
            try {
                std::regex re(matcher.pattern);
                return std::regex_search(actual, re);
            } catch (...) {
                return false;
            }
    }

    return false;
}

bool ElementMatcher::matchesState(
    ShadowNodePtr node,
    const SelectorCriteria& criteria
) {
    // Get ViewProps for state info
    auto viewProps = std::dynamic_pointer_cast<const facebook::react::ViewProps>(
        node->getProps()
    );

    // Match enabled
    if (criteria.enabled.has_value()) {
        // Default to enabled if no pointerEvents prop
        bool isEnabled = true;
        if (viewProps) {
            // Check pointerEvents - none means disabled for interactions
            isEnabled = viewProps->pointerEvents != facebook::react::PointerEventsMode::None;
        }
        if (isEnabled != *criteria.enabled) {
            return false;
        }
    }

    // For checked, focused, selected - extract from node props
    bool checked = false, focused = false, selected = false;
    extractStateProps(node, checked, focused, selected);

    if (criteria.checked.has_value() && checked != *criteria.checked) {
        return false;
    }

    if (criteria.focused.has_value() && focused != *criteria.focused) {
        return false;
    }

    if (criteria.selected.has_value() && selected != *criteria.selected) {
        return false;
    }

    return true;
}

bool ElementMatcher::matchesSpatial(
    ShadowNodePtr node,
    const LayoutMetrics& nodeMetrics,
    const MatchContext& ctx
) {
    // Check 'below' - node must be below the reference
    if (ctx.belowRef) {
        if (!isBelow(nodeMetrics, *ctx.belowRef)) {
            return false;
        }
    }

    // Check 'above' - node must be above the reference
    if (ctx.aboveRef) {
        if (!isAbove(nodeMetrics, *ctx.aboveRef)) {
            return false;
        }
    }

    // Check 'leftOf' - node must be left of the reference
    if (ctx.leftOfRef) {
        if (!isLeftOf(nodeMetrics, *ctx.leftOfRef)) {
            return false;
        }
    }

    // Check 'rightOf' - node must be right of the reference
    if (ctx.rightOfRef) {
        if (!isRightOf(nodeMetrics, *ctx.rightOfRef)) {
            return false;
        }
    }

    return true;
}

bool ElementMatcher::isBelow(const LayoutMetrics& candidate, const LayoutMetrics& reference) {
    // Candidate's top edge must be below reference's bottom edge
    return candidate.screenY > (reference.screenY + reference.height);
}

bool ElementMatcher::isAbove(const LayoutMetrics& candidate, const LayoutMetrics& reference) {
    // Candidate's bottom edge must be above reference's top edge
    return (candidate.screenY + candidate.height) < reference.screenY;
}

bool ElementMatcher::isLeftOf(const LayoutMetrics& candidate, const LayoutMetrics& reference) {
    // Candidate's right edge must be left of reference's left edge
    return (candidate.screenX + candidate.width) < reference.screenX;
}

bool ElementMatcher::isRightOf(const LayoutMetrics& candidate, const LayoutMetrics& reference) {
    // Candidate's left edge must be right of reference's right edge
    return candidate.screenX > (reference.screenX + reference.width);
}

bool ElementMatcher::matchesHierarchical(
    ShadowNodePtr node,
    const SelectorCriteria& criteria,
    const MatchContext& ctx
) {
    // Check containsChild
    if (criteria.containsChild) {
        if (!containsChild(node, *criteria.containsChild, ctx)) {
            return false;
        }
    }

    // Check childOf
    if (criteria.childOf) {
        if (!isChildOf(ctx.parentChain, *criteria.childOf, ctx)) {
            return false;
        }
    }

    // Check containsDescendants
    if (!criteria.containsDescendants.empty()) {
        if (!containsDescendants(node, criteria.containsDescendants, ctx)) {
            return false;
        }
    }

    return true;
}

bool ElementMatcher::containsChild(
    ShadowNodePtr node,
    const SelectorCriteria& criteria,
    const MatchContext& ctx
) {
    // Check direct children only
    for (const auto& child : node->getChildren()) {
        // Create a simple criteria check (without recursion for children)
        if (matchesPrimary(child, criteria) && matchesState(child, criteria)) {
            return true;
        }
    }
    return false;
}

bool ElementMatcher::isChildOf(
    const std::vector<const facebook::react::ShadowNode*>& parentChain,
    const SelectorCriteria& criteria,
    const MatchContext& ctx
) {
    // Walk up the parent chain
    for (const auto* parent : parentChain) {
        // Create shared_ptr wrapper for the parent (without ownership)
        // We need to check if parent matches criteria
        auto parentPtr = std::shared_ptr<const facebook::react::ShadowNode>(
            parent, [](const facebook::react::ShadowNode*) {} // no-op deleter
        );

        if (matchesPrimary(parentPtr, criteria)) {
            return true;
        }
    }
    return false;
}

bool ElementMatcher::containsDescendants(
    ShadowNodePtr node,
    const std::vector<SelectorCriteriaPtr>& criteriaList,
    const MatchContext& ctx
) {
    // All criteria must match at least one descendant
    for (const auto& criteria : criteriaList) {
        bool found = false;

        // DFS to find any matching descendant
        std::function<bool(ShadowNodePtr)> search = [&](ShadowNodePtr n) -> bool {
            if (matchesPrimary(n, *criteria) && matchesState(n, *criteria)) {
                return true;
            }
            for (const auto& child : n->getChildren()) {
                if (search(child)) {
                    return true;
                }
            }
            return false;
        };

        // Search in children (not including the node itself)
        for (const auto& child : node->getChildren()) {
            if (search(child)) {
                found = true;
                break;
            }
        }

        if (!found) {
            return false;
        }
    }
    return true;
}

bool ElementMatcher::matchesDimensions(
    const LayoutMetrics& metrics,
    const SelectorCriteria& criteria
) {
    float tol = criteria.tolerance.value_or(0.0f);

    if (criteria.width) {
        float diff = std::abs(metrics.width - *criteria.width);
        if (diff > tol) {
            return false;
        }
    }

    if (criteria.height) {
        float diff = std::abs(metrics.height - *criteria.height);
        if (diff > tol) {
            return false;
        }
    }

    return true;
}

bool ElementMatcher::matchesTraits(
    ShadowNodePtr node,
    const LayoutMetrics& metrics,
    const std::vector<Trait>& traits
) {
    for (const auto& trait : traits) {
        switch (trait) {
            case Trait::Text: {
                auto text = ShadowTreeTraverser::getText(node);
                if (!text || text->empty()) {
                    return false;
                }
                break;
            }

            case Trait::LongText: {
                auto text = ShadowTreeTraverser::getText(node);
                if (!text || text->size() < 200) {
                    return false;
                }
                break;
            }

            case Trait::Square: {
                // Width approximately equals height (within 10%)
                float ratio = metrics.width / std::max(metrics.height, 0.001f);
                if (ratio < 0.9f || ratio > 1.1f) {
                    return false;
                }
                break;
            }
        }
    }
    return true;
}

std::optional<LayoutMetrics> ElementMatcher::getNodeMetrics(
    ShadowNodePtr root,
    ShadowNodePtr node
) {
    // Get testID to use existing layout metrics function
    auto testID = ShadowTreeTraverser::getTestID(*node);
    if (testID) {
        return ShadowTreeTraverser::getLayoutMetrics(root, *testID);
    }

    // Fallback: get local metrics
    auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node.get());
    if (!layoutable) {
        return std::nullopt;
    }

    auto fbMetrics = layoutable->getLayoutMetrics();
    LayoutMetrics metrics;
    metrics.x = fbMetrics.frame.origin.x;
    metrics.y = fbMetrics.frame.origin.y;
    metrics.width = fbMetrics.frame.size.width;
    metrics.height = fbMetrics.frame.size.height;
    // Note: screenX/Y won't be accurate without parent chain
    metrics.screenX = metrics.x;
    metrics.screenY = metrics.y;

    return metrics;
}

void ElementMatcher::extractStateProps(
    ShadowNodePtr node,
    bool& outChecked,
    bool& outFocused,
    bool& outSelected
) {
    outChecked = false;
    outFocused = false;
    outSelected = false;

    // Try to get accessibilityState from ViewProps
    auto viewProps = std::dynamic_pointer_cast<const facebook::react::ViewProps>(
        node->getProps()
    );

    if (viewProps && viewProps->accessibilityState.has_value()) {
        // Check accessibilityState
        const auto& accState = viewProps->accessibilityState.value();
        // checked is an inline enum: { Unchecked=0, Checked=1, Mixed=2, None=3 }
        // Treat Checked (1) and Mixed (2) as true
        outChecked = (accState.checked == 1 || accState.checked == 2);
        outSelected = accState.selected;

        // Focused state is typically tracked at runtime, not in props
        // For now, we can't reliably determine focus from shadow tree
    }
}

void ElementMatcher::collectMatches(
    ShadowNodePtr node,
    const SelectorCriteria& criteria,
    MatchContext& ctx,
    std::vector<ShadowNodePtr>& results
) {
    if (!node) {
        return;
    }

    // Check if this node matches
    if (matches(node, criteria, ctx)) {
        results.push_back(node);
        // Debug log first 5 matches
        if (results.size() <= 5 && criteria.text) {
            auto nodeText = ShadowTreeTraverser::getText(node);
            auto testID = ShadowTreeTraverser::getTestID(*node);
            EM_LOG("collectMatches: MATCH #%zu testID=%s text='%.30s...'",
                results.size(),
                testID ? testID->c_str() : "none",
                nodeText ? nodeText->c_str() : "null");
        }
    }

    // Track parent chain for hierarchical queries
    ctx.parentChain.push_back(node.get());

    // Recurse into children
    for (const auto& child : node->getChildren()) {
        collectMatches(child, criteria, ctx, results);
    }

    // Pop from parent chain
    ctx.parentChain.pop_back();
}

} // namespace tasto
