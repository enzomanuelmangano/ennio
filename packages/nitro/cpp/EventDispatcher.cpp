#include "EventDispatcher.hpp"

#include <thread>
#include <chrono>

#include <react/renderer/core/LayoutableShadowNode.h>
#include <react/renderer/components/view/ViewEventEmitter.h>

namespace tasto {

bool EventDispatcher::tap(ShadowNodePtr node) {
    if (!node) {
        return false;
    }

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        return false;
    }

    auto [centerX, centerY] = getCenterPoint(node);

    // Fire touch sequence
    dispatchTouchEvent(emitter, "touchStart", centerX, centerY);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    dispatchTouchEvent(emitter, "touchEnd", centerX, centerY);

    return true;
}

bool EventDispatcher::longPress(ShadowNodePtr node, int durationMs) {
    if (!node) {
        return false;
    }

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        return false;
    }

    auto [centerX, centerY] = getCenterPoint(node);

    dispatchTouchEvent(emitter, "touchStart", centerX, centerY);
    std::this_thread::sleep_for(std::chrono::milliseconds(durationMs));
    dispatchTouchEvent(emitter, "touchEnd", centerX, centerY);

    return true;
}

bool EventDispatcher::typeText(ShadowNodePtr node, const std::string& text) {
    if (!node) {
        return false;
    }

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        return false;
    }

    // In a full implementation, we would dispatch onChange events
    // with proper TextInputMetrics structures.
    // For now, this is a placeholder that returns success.
    // The actual text input would need to go through the UIManager
    // to update the component state.

    return true;
}

bool EventDispatcher::clearText(ShadowNodePtr node) {
    return replaceText(node, "");
}

bool EventDispatcher::replaceText(ShadowNodePtr node, const std::string& text) {
    if (!node) {
        return false;
    }

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        return false;
    }

    // Placeholder - actual implementation would dispatch onChange
    return true;
}

bool EventDispatcher::scroll(ShadowNodePtr node, float deltaX, float deltaY) {
    if (!node) {
        return false;
    }

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        return false;
    }

    // Placeholder - actual implementation would dispatch scroll events
    // through the ScrollViewEventEmitter with proper metrics
    return true;
}

bool EventDispatcher::scrollTo(
    ShadowNodePtr scrollView,
    ShadowNodePtr targetElement
) {
    if (!scrollView || !targetElement) {
        return false;
    }

    auto targetLayoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(targetElement.get());
    if (!targetLayoutable) {
        return false;
    }

    auto metrics = targetLayoutable->getLayoutMetrics();
    return scroll(scrollView, metrics.frame.origin.x, metrics.frame.origin.y);
}

bool EventDispatcher::scrollToIndex(ShadowNodePtr listNode, int index) {
    if (!listNode || index < 0) {
        return false;
    }

    // Estimate position based on item height
    float estimatedItemHeight = 50.0f;
    float targetY = index * estimatedItemHeight;

    return scroll(listNode, 0, targetY);
}

bool EventDispatcher::swipe(
    ShadowNodePtr node,
    ScrollDirection direction,
    float distance
) {
    if (!node) {
        return false;
    }

    float deltaX = 0;
    float deltaY = 0;

    switch (direction) {
        case ScrollDirection::Up:
            deltaY = -distance;
            break;
        case ScrollDirection::Down:
            deltaY = distance;
            break;
        case ScrollDirection::Left:
            deltaX = -distance;
            break;
        case ScrollDirection::Right:
            deltaX = distance;
            break;
    }

    return scroll(node, deltaX, deltaY);
}

bool EventDispatcher::focus(ShadowNodePtr node) {
    if (!node) {
        return false;
    }

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        return false;
    }

    // Placeholder - actual implementation would dispatch onFocus
    return true;
}

bool EventDispatcher::blur(ShadowNodePtr node) {
    if (!node) {
        return false;
    }

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        return false;
    }

    // Placeholder - actual implementation would dispatch onBlur
    return true;
}

facebook::react::SharedEventEmitter EventDispatcher::getEventEmitter(ShadowNodePtr node) {
    if (!node) {
        return nullptr;
    }

    return node->getEventEmitter();
}

void EventDispatcher::dispatchTouchEvent(
    facebook::react::SharedEventEmitter emitter,
    const std::string& eventType,
    float x,
    float y
) {
    if (!emitter) {
        return;
    }

    // In a full implementation, we would construct proper Touch event payloads
    // using RawEvent or TouchEvent structures from React Native.
    // This would involve creating touch point structures with
    // identifier, coordinates, timestamp, etc.
    //
    // The actual dispatch would look something like:
    // emitter->dispatchEvent(eventType, [&](jsi::Runtime& runtime) {
    //     auto payload = jsi::Object(runtime);
    //     // ... populate touch event data
    //     return payload;
    // });
}

std::pair<float, float> EventDispatcher::getCenterPoint(ShadowNodePtr node) {
    auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node.get());
    if (!layoutable) {
        return {0, 0};
    }

    auto metrics = layoutable->getLayoutMetrics();
    float centerX = metrics.frame.origin.x + metrics.frame.size.width / 2;
    float centerY = metrics.frame.origin.y + metrics.frame.size.height / 2;

    return {centerX, centerY};
}

} // namespace tasto
