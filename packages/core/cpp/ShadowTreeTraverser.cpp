#include "ShadowTreeTraverser.hpp"

#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/components/text/RawTextProps.h>
#include <react/renderer/core/LayoutableShadowNode.h>

namespace ennio {

ShadowTreeTraverser::ShadowNodePtr ShadowTreeTraverser::findByTestID(
    ShadowNodePtr root,
    const std::string& testID
) {
    if (!root || testID.empty()) {
        return nullptr;
    }

    // Check current node
    auto nodeTestID = getTestID(*root);
    if (nodeTestID && *nodeTestID == testID) {
        return root;
    }

    // Recursively search children
    for (const auto& child : root->getChildren()) {
        auto result = findByTestID(child, testID);
        if (result) {
            return result;
        }
    }

    return nullptr;
}

bool ShadowTreeTraverser::exists(ShadowNodePtr root, const std::string& testID) {
    return findByTestID(root, testID) != nullptr;
}

std::optional<ElementInfo> ShadowTreeTraverser::getElementInfo(ShadowNodePtr node) {
    if (!node) {
        return std::nullopt;
    }

    ElementInfo info;

    // Get testID
    auto testID = getTestID(*node);
    info.testID = testID.value_or("");

    // Get component name/type
    info.type = node->getComponentName();

    // Get text content if available
    info.text = getText(node);

    // Default values
    info.accessible = false;
    info.enabled = true;

    // Try to get ViewProps for accessibility info
    auto viewProps = std::dynamic_pointer_cast<const facebook::react::ViewProps>(
        node->getProps()
    );

    if (viewProps) {
        info.accessible = viewProps->accessible;
    }

    // Get layout metrics
    auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node.get());
    if (layoutable) {
        auto metrics = layoutable->getLayoutMetrics();
        info.layout.x = metrics.frame.origin.x;
        info.layout.y = metrics.frame.origin.y;
        info.layout.width = metrics.frame.size.width;
        info.layout.height = metrics.frame.size.height;
        info.layout.screenX = metrics.frame.origin.x;
        info.layout.screenY = metrics.frame.origin.y;
    }

    return info;
}

std::optional<LayoutMetrics> ShadowTreeTraverser::getLayoutMetrics(
    ShadowNodePtr root,
    const std::string& testID
) {
    if (!root || testID.empty()) {
        return std::nullopt;
    }

    std::vector<const facebook::react::ShadowNode*> path;
    auto node = findByTestIDWithPath(root, testID, path);

    if (!node) {
        return std::nullopt;
    }

    auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node.get());
    if (!layoutable) {
        return std::nullopt;
    }

    auto metrics = layoutable->getLayoutMetrics();
    auto [offsetX, offsetY] = calculateAccumulatedOffset(path);

    LayoutMetrics result;
    result.x = metrics.frame.origin.x;
    result.y = metrics.frame.origin.y;
    result.width = metrics.frame.size.width;
    result.height = metrics.frame.size.height;
    result.screenX = metrics.frame.origin.x + offsetX;
    result.screenY = metrics.frame.origin.y + offsetY;

    return result;
}

bool ShadowTreeTraverser::isVisible(
    ShadowNodePtr root,
    const std::string& testID,
    float screenWidth,
    float screenHeight
) {
    auto metrics = getLayoutMetrics(root, testID);
    if (!metrics) {
        return false;
    }

    // Check if element is within screen bounds
    if (metrics->screenX + metrics->width < 0 ||
        metrics->screenY + metrics->height < 0 ||
        metrics->screenX > screenWidth ||
        metrics->screenY > screenHeight) {
        return false;
    }

    // Check if element has valid size
    if (metrics->width <= 0 || metrics->height <= 0) {
        return false;
    }

    return true;
}

std::optional<std::string> ShadowTreeTraverser::getText(ShadowNodePtr node) {
    if (!node) {
        return std::nullopt;
    }

    // Check for RawText props
    auto rawTextProps = std::dynamic_pointer_cast<const facebook::react::RawTextProps>(
        node->getProps()
    );

    if (rawTextProps) {
        return rawTextProps->text;
    }

    // For Text components, traverse children to find RawText
    std::string combinedText;

    for (const auto& child : node->getChildren()) {
        auto childText = getText(child);
        if (childText) {
            combinedText += *childText;
        }
    }

    if (!combinedText.empty()) {
        return combinedText;
    }

    return std::nullopt;
}

void ShadowTreeTraverser::traverse(
    ShadowNodePtr root,
    const VisitorCallback& visitor
) {
    if (!root) {
        return;
    }

    traverseInternal(*root, visitor, 0);
}

std::optional<std::string> ShadowTreeTraverser::getTestID(
    const facebook::react::ShadowNode& node
) {
    auto viewProps = std::dynamic_pointer_cast<const facebook::react::ViewProps>(
        node.getProps()
    );

    if (viewProps && !viewProps->testId.empty()) {
        return viewProps->testId;
    }

    return std::nullopt;
}

bool ShadowTreeTraverser::traverseInternal(
    const facebook::react::ShadowNode& node,
    const VisitorCallback& visitor,
    int depth
) {
    // Visit current node
    if (!visitor(node, depth)) {
        return false; // Stop traversal
    }

    // Visit children
    for (const auto& child : node.getChildren()) {
        if (!traverseInternal(*child, visitor, depth + 1)) {
            return false;
        }
    }

    return true;
}

ShadowTreeTraverser::ShadowNodePtr ShadowTreeTraverser::findByTestIDWithPath(
    ShadowNodePtr root,
    const std::string& testID,
    std::vector<const facebook::react::ShadowNode*>& path
) {
    if (!root) {
        return nullptr;
    }

    // Check current node
    auto nodeTestID = getTestID(*root);
    if (nodeTestID && *nodeTestID == testID) {
        return root;
    }

    // Add current node to path and search children
    path.push_back(root.get());

    for (const auto& child : root->getChildren()) {
        auto result = findByTestIDWithPath(child, testID, path);
        if (result) {
            return result;
        }
    }

    // Not found in this branch, remove from path
    path.pop_back();

    return nullptr;
}

std::pair<float, float> ShadowTreeTraverser::calculateAccumulatedOffset(
    const std::vector<const facebook::react::ShadowNode*>& path
) {
    float offsetX = 0;
    float offsetY = 0;

    for (const auto* node : path) {
        auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node);
        if (layoutable) {
            auto metrics = layoutable->getLayoutMetrics();
            offsetX += metrics.frame.origin.x;
            offsetY += metrics.frame.origin.y;
        }
    }

    return {offsetX, offsetY};
}

} // namespace ennio
