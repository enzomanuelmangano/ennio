#include "ShadowTreeTraverser.hpp"

#include <cmath>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/components/text/RawTextProps.h>
#include <react/renderer/components/textinput/TextInputProps.h>
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

    // Explicit zero-init: ElementInfo::Layout has plain `float` members
    // with no in-class initialisers, so omitting this leaves uninit
    // stack garbage in any field the sanity check below rejects.
    ElementInfo info = {};

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

    // Get layout metrics. Sanity-check the values before copying: Yoga
    // returns sentinel `YGUndefined` (NaN-ish or FLT_MAX-ish) for nodes
    // that haven't been laid out yet. A freshly mounted Text inside an
    // animated AddHabitCard read mid-stagger has frame values like
    // (80, 1.3364e+27, 1.4013e-45, 1.3364e+27); without this guard, those
    // leak into screenX/screenY, then into writer.layoutCenter, then
    // into an HID tap at (96, 2e27) — completely off-screen, fires no
    // gesture, breaks the cascade.
    auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node.get());
    if (layoutable) {
        auto metrics = layoutable->getLayoutMetrics();
        // Reject subnormal Yoga sentinels (1.4e-45 etc) too — `isfinite`
        // alone treats them as valid, but real RN frame values never go
        // below 1e-3 pt.
        auto ok = [](float v) {
            if (!std::isfinite(v)) return false;
            float a = std::fabs(v);
            if (a > 1e6f) return false;
            return a == 0.0f || a >= 1e-3f;
        };
        if (ok(metrics.frame.origin.x) && ok(metrics.frame.origin.y)
            && ok(metrics.frame.size.width) && ok(metrics.frame.size.height)) {
            info.layout.x = metrics.frame.origin.x;
            info.layout.y = metrics.frame.origin.y;
            info.layout.width = metrics.frame.size.width;
            info.layout.height = metrics.frame.size.height;
            info.layout.screenX = metrics.frame.origin.x;
            info.layout.screenY = metrics.frame.origin.y;
        }
        // else: leave zero-initialised. Caller's `width > 0 && height > 0`
        // check (already in layoutCenter / isVisibleBySelector) will treat
        // the node as un-laid-out and skip it.
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

    // TextInput: expose placeholder as the matchable text. Maestro flows
    // commonly use `tapOn: text: "Email"` to focus a field whose only
    // visible label is the placeholder, so without this we'd miss every
    // form field.
    auto textInputProps = std::dynamic_pointer_cast<const facebook::react::TextInputProps>(
        node->getProps()
    );
    if (textInputProps) {
        // Prefer the current value if set (matches typed-in text), else
        // fall back to the placeholder hint shown when the field is empty.
        if (!textInputProps->text.empty()) {
            return textInputProps->text;
        }
        if (!textInputProps->placeholder.empty()) {
            return textInputProps->placeholder;
        }
    }

    // Only recurse for actual Text components (Fabric component name
    // "Paragraph"). Recursing for arbitrary Views concatenates the entire
    // subtree's text, which causes containers to falsely match short
    // patterns like "1" — e.g. a screen-root View whose combined-text
    // happens to include a price digit. Spatial selectors then evaluate
    // those bogus matches against the wrong layout box.
    const char* compName = node->getComponentName();
    if (!compName) {
        return std::nullopt;
    }
    std::string name(compName);
    // Paragraph: top-level Fabric Text. Text: nested-inline Text inside
    // another Text. Both should aggregate their RawText children. Other
    // components (View, ScrollView, etc) must NOT recurse — otherwise a
    // container's combined text causes false matches against descendants.
    if (name != "Paragraph" && name != "Text") {
        return std::nullopt;
    }

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

    // Same Yoga-sentinel guard as `getElementInfo`: any ancestor with a
    // non-finite or absurdly large frame.origin would otherwise poison the
    // sum and emit tap coordinates like (96, 2e27). A freshly mounted
    // Reanimated animated card mid-stagger surfaces those values on its
    // parent View even when the target node itself is laid out. Skip
    // those contributions — the accumulated offset for an un-laid-out
    // subtree is meaningless; caller's `width > 0 && height > 0` check on
    // the resolved layout will reject the node before any tap.
    // Tighten lower bound: Yoga's "undefined" sentinel sometimes
    // leaks through as a subnormal like 1.4e-45 — `std::isfinite`
    // returns true for it, `fabs < 1e6` accepts it. Real RN frame
    // values are never subnormal; reject anything below 1e-3.
    auto ok = [](float v) {
        if (!std::isfinite(v)) return false;
        float a = std::fabs(v);
        if (a > 1e6f) return false;
        return a == 0.0f || a >= 1e-3f;
    };
    for (const auto* node : path) {
        auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node);
        if (!layoutable) continue;
        auto metrics = layoutable->getLayoutMetrics();
        if (ok(metrics.frame.origin.x) && ok(metrics.frame.origin.y)) {
            offsetX += metrics.frame.origin.x;
            offsetY += metrics.frame.origin.y;
        }
    }

    return {offsetX, offsetY};
}

namespace {
    bool buildPathToNode(
        ShadowTreeTraverser::ShadowNodePtr root,
        ShadowTreeTraverser::ShadowNodePtr target,
        std::vector<const facebook::react::ShadowNode*>& path
    ) {
        if (!root || !target) return false;
        if (root.get() == target.get()) return true;
        path.push_back(root.get());
        for (const auto& child : root->getChildren()) {
            if (buildPathToNode(child, target, path)) return true;
        }
        path.pop_back();
        return false;
    }
}

std::pair<float, float> ShadowTreeTraverser::getAbsoluteOffset(
    ShadowNodePtr root,
    ShadowNodePtr target
) {
    std::vector<const facebook::react::ShadowNode*> path;
    if (!buildPathToNode(root, target, path)) {
        return {0.0f, 0.0f};
    }
    return calculateAccumulatedOffset(path);
}

} // namespace ennio
