#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>

#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/core/LayoutMetrics.h>

namespace tasto {

/**
 * Information about a found element
 */
struct ElementInfo {
    std::string testID;
    std::string type;
    std::optional<std::string> text;
    bool accessible;
    bool enabled;

    struct Layout {
        float x;
        float y;
        float width;
        float height;
        float screenX;
        float screenY;
    } layout;
};

/**
 * Layout metrics for an element
 */
struct LayoutMetrics {
    float x;
    float y;
    float width;
    float height;
    float screenX;
    float screenY;
};

/**
 * ShadowTreeTraverser provides methods to query and traverse
 * the React Native Fabric shadow tree.
 */
class ShadowTreeTraverser {
public:
    using ShadowNodePtr = std::shared_ptr<const facebook::react::ShadowNode>;
    using VisitorCallback = std::function<bool(const facebook::react::ShadowNode&, int depth)>;

    /**
     * Find a ShadowNode by testID in the given tree
     * @param root - Root of the shadow tree to search
     * @param testID - The testID to search for
     * @return Shared pointer to the node if found, nullptr otherwise
     */
    static ShadowNodePtr findByTestID(
        ShadowNodePtr root,
        const std::string& testID
    );

    /**
     * Check if a node with the given testID exists
     */
    static bool exists(ShadowNodePtr root, const std::string& testID);

    /**
     * Get element information for a node
     */
    static std::optional<ElementInfo> getElementInfo(ShadowNodePtr node);

    /**
     * Get layout metrics for a node
     * Calculates absolute screen position by traversing parent chain
     */
    static std::optional<LayoutMetrics> getLayoutMetrics(
        ShadowNodePtr root,
        const std::string& testID
    );

    /**
     * Check if a node is visible on screen
     * Considers: opacity, display, pointerEvents, parent chain, viewport bounds
     */
    static bool isVisible(
        ShadowNodePtr root,
        const std::string& testID,
        float screenWidth,
        float screenHeight
    );

    /**
     * Get text content from a node (for Text components)
     */
    static std::optional<std::string> getText(ShadowNodePtr node);

    /**
     * Traverse the shadow tree depth-first
     * @param root - Root node to start traversal
     * @param visitor - Callback function, return false to stop traversal
     */
    static void traverse(
        ShadowNodePtr root,
        const VisitorCallback& visitor
    );

    /**
     * Get the testID from a ShadowNode if available
     */
    static std::optional<std::string> getTestID(const facebook::react::ShadowNode& node);

private:
    /**
     * Internal traversal helper with depth tracking
     */
    static bool traverseInternal(
        const facebook::react::ShadowNode& node,
        const VisitorCallback& visitor,
        int depth
    );

    /**
     * Find node and accumulate transforms for absolute positioning
     */
    static ShadowNodePtr findByTestIDWithPath(
        ShadowNodePtr root,
        const std::string& testID,
        std::vector<const facebook::react::ShadowNode*>& path
    );

    /**
     * Calculate accumulated offset from root to target
     */
    static std::pair<float, float> calculateAccumulatedOffset(
        const std::vector<const facebook::react::ShadowNode*>& path
    );
};

} // namespace tasto
