#include "EventDispatcher.hpp"

#include <thread>
#include <chrono>

#include <react/renderer/core/LayoutableShadowNode.h>
#include <react/renderer/components/view/ViewEventEmitter.h>
#include <react/renderer/components/view/ViewProps.h>

// iOS-specific native tap support
#if defined(__APPLE__)
#include "../ios/TastoRuntimeHelper.h"
#endif

namespace tasto {

bool EventDispatcher::tap(ShadowNodePtr node) {
    if (!node) {
        fprintf(stderr, "[Tasto] EventDispatcher::tap: node is null\n");
        return false;
    }

    // Use event dispatch approach on all platforms
    // This dispatches events directly through React's event system
    auto emitter = getEventEmitter(node);
    if (!emitter) {
        fprintf(stderr, "[Tasto] EventDispatcher::tap: emitter is null for tag=%d\n", node->getTag());
        return false;
    }

    auto [centerX, centerY] = getCenterPoint(node);

    // Get the node's tag for proper touch targeting
    int32_t nodeTag = node->getTag();

    // Create timestamp
    auto now = std::chrono::system_clock::now();
    double timestamp = static_cast<double>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()
        ).count()
    );

    fprintf(stderr, "[Tasto] EventDispatcher::tap: tag=%d, center=(%.1f, %.1f)\n", nodeTag, centerX, centerY);

    // Dispatch touch and click events through the event emitter
    // This directly triggers the React Native event handlers
    dispatchTouchEvent(emitter, "touchStart", centerX, centerY, nodeTag, timestamp);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    dispatchTouchEvent(emitter, "touchEnd", centerX, centerY, nodeTag, timestamp);

    // Dispatch click event - this is what triggers onPress in Pressable
    dispatchClickEvent(emitter, centerX, centerY);

    fprintf(stderr, "[Tasto] EventDispatcher::tap: completed\n");
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
    int32_t nodeTag = node->getTag();

    auto now = std::chrono::system_clock::now();
    double timestamp = static_cast<double>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()
        ).count()
    );

    // For long press, hold the touch for the duration
    dispatchTouchEvent(emitter, "touchStart", centerX, centerY, nodeTag, timestamp);
    std::this_thread::sleep_for(std::chrono::milliseconds(durationMs));
    dispatchTouchEvent(emitter, "touchEnd", centerX, centerY, nodeTag, timestamp);

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

    // First, tap to focus the input
    auto [centerX, centerY] = getCenterPoint(node);
    int32_t nodeTag = node->getTag();

    auto now = std::chrono::system_clock::now();
    double timestamp = static_cast<double>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()
        ).count()
    );

    dispatchTouchEvent(emitter, "touchStart", centerX, centerY, nodeTag, timestamp);
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    dispatchTouchEvent(emitter, "touchEnd", centerX, centerY, nodeTag, timestamp);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    // Dispatch changeText event with the text
    dispatchTextChangeEvent(emitter, text);

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

    // Dispatch changeText event to replace the text
    dispatchTextChangeEvent(emitter, text);

    return true;
}

bool EventDispatcher::scroll(ShadowNodePtr node, float deltaX, float deltaY) {
    if (!node) {
        fprintf(stderr, "[Tasto] EventDispatcher::scroll: node is null\n");
        return false;
    }

#if defined(__APPLE__)
    // On iOS, use native scroll which properly scrolls the UIScrollView
    // Get the testID from the node's props
    auto viewProps = std::dynamic_pointer_cast<const facebook::react::ViewProps>(node->getProps());
    if (viewProps && !viewProps->testId.empty()) {
        auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
        bool result = helper.performScroll(viewProps->testId, deltaX, deltaY);
        if (result) {
            return true;
        }
    }
    // Fall through to event dispatch if native scroll fails
#endif

    auto emitter = getEventEmitter(node);
    if (!emitter) {
        fprintf(stderr, "[Tasto] EventDispatcher::scroll: emitter is null\n");
        return false;
    }

    // Dispatch scroll event as fallback
    dispatchScrollEvent(emitter, deltaX, deltaY);

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

    // Focusing requires tapping the element
    return tap(node);
}

bool EventDispatcher::blur(ShadowNodePtr node) {
    if (!node) {
        return false;
    }

    // Blurring typically happens when focusing elsewhere
    // For now, return true if the node exists
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
    float y,
    int32_t target,
    double timestamp
) {
    if (!emitter) {
        return;
    }

    // Dispatch touch events (touchStart, touchEnd, touchMove, touchCancel)
    // This matches the structure expected by React Native's touch system
    emitter->dispatchEvent(
        eventType,
        [x, y, target, timestamp](facebook::jsi::Runtime& runtime) {
            auto payload = facebook::jsi::Object(runtime);

            // Create touch object matching React Native's Touch structure
            auto touch = facebook::jsi::Object(runtime);
            touch.setProperty(runtime, "pageX", x);
            touch.setProperty(runtime, "pageY", y);
            touch.setProperty(runtime, "locationX", x);
            touch.setProperty(runtime, "locationY", y);
            touch.setProperty(runtime, "screenX", x);
            touch.setProperty(runtime, "screenY", y);
            touch.setProperty(runtime, "identifier", 0);
            touch.setProperty(runtime, "target", target);
            touch.setProperty(runtime, "force", 1.0);
            touch.setProperty(runtime, "timestamp", timestamp);

            // Create touches arrays
            auto touches = facebook::jsi::Array(runtime, 1);
            touches.setValueAtIndex(runtime, 0, touch);

            auto changedTouches = facebook::jsi::Array(runtime, 1);
            // Clone touch for changedTouches
            auto changedTouch = facebook::jsi::Object(runtime);
            changedTouch.setProperty(runtime, "pageX", x);
            changedTouch.setProperty(runtime, "pageY", y);
            changedTouch.setProperty(runtime, "locationX", x);
            changedTouch.setProperty(runtime, "locationY", y);
            changedTouch.setProperty(runtime, "screenX", x);
            changedTouch.setProperty(runtime, "screenY", y);
            changedTouch.setProperty(runtime, "identifier", 0);
            changedTouch.setProperty(runtime, "target", target);
            changedTouch.setProperty(runtime, "force", 1.0);
            changedTouch.setProperty(runtime, "timestamp", timestamp);
            changedTouches.setValueAtIndex(runtime, 0, changedTouch);

            auto targetTouches = facebook::jsi::Array(runtime, 1);
            auto targetTouch = facebook::jsi::Object(runtime);
            targetTouch.setProperty(runtime, "pageX", x);
            targetTouch.setProperty(runtime, "pageY", y);
            targetTouch.setProperty(runtime, "locationX", x);
            targetTouch.setProperty(runtime, "locationY", y);
            targetTouch.setProperty(runtime, "screenX", x);
            targetTouch.setProperty(runtime, "screenY", y);
            targetTouch.setProperty(runtime, "identifier", 0);
            targetTouch.setProperty(runtime, "target", target);
            targetTouch.setProperty(runtime, "force", 1.0);
            targetTouch.setProperty(runtime, "timestamp", timestamp);
            targetTouches.setValueAtIndex(runtime, 0, targetTouch);

            payload.setProperty(runtime, "touches", touches);
            payload.setProperty(runtime, "changedTouches", changedTouches);
            payload.setProperty(runtime, "targetTouches", targetTouches);

            // Also set touch properties at root level (React Native does this)
            payload.setProperty(runtime, "pageX", x);
            payload.setProperty(runtime, "pageY", y);
            payload.setProperty(runtime, "locationX", x);
            payload.setProperty(runtime, "locationY", y);
            payload.setProperty(runtime, "screenX", x);
            payload.setProperty(runtime, "screenY", y);
            payload.setProperty(runtime, "identifier", 0);
            payload.setProperty(runtime, "target", target);
            payload.setProperty(runtime, "force", 1.0);
            payload.setProperty(runtime, "timestamp", timestamp);

            return payload;
        }
    );
}

void EventDispatcher::dispatchClickEvent(
    facebook::react::SharedEventEmitter emitter,
    float x,
    float y
) {
    if (!emitter) {
        return;
    }

    // Dispatch click event - this triggers onPress in Pressable components
    emitter->dispatchEvent(
        "click",
        [x, y](facebook::jsi::Runtime& runtime) {
            auto payload = facebook::jsi::Object(runtime);

            // PointerEvent structure for click
            payload.setProperty(runtime, "pointerId", 0);
            payload.setProperty(runtime, "pressure", 1.0);
            payload.setProperty(runtime, "pointerType", "touch");
            payload.setProperty(runtime, "clientX", x);
            payload.setProperty(runtime, "clientY", y);
            payload.setProperty(runtime, "screenX", x);
            payload.setProperty(runtime, "screenY", y);
            payload.setProperty(runtime, "offsetX", x);
            payload.setProperty(runtime, "offsetY", y);
            payload.setProperty(runtime, "pageX", x);
            payload.setProperty(runtime, "pageY", y);
            payload.setProperty(runtime, "width", 1.0);
            payload.setProperty(runtime, "height", 1.0);
            payload.setProperty(runtime, "tiltX", 0);
            payload.setProperty(runtime, "tiltY", 0);
            payload.setProperty(runtime, "detail", 1);
            payload.setProperty(runtime, "buttons", 0);
            payload.setProperty(runtime, "tangentialPressure", 0.0);
            payload.setProperty(runtime, "twist", 0);
            payload.setProperty(runtime, "ctrlKey", false);
            payload.setProperty(runtime, "shiftKey", false);
            payload.setProperty(runtime, "altKey", false);
            payload.setProperty(runtime, "metaKey", false);
            payload.setProperty(runtime, "isPrimary", true);
            payload.setProperty(runtime, "button", 0);

            return payload;
        }
    );
}

void EventDispatcher::dispatchPressEvent(
    facebook::react::SharedEventEmitter emitter,
    const std::string& eventType,
    float x,
    float y
) {
    if (!emitter) {
        return;
    }

    // Dispatch press events for Pressable components (pressIn, press, pressOut)
    emitter->dispatchEvent(
        eventType,
        [x, y](facebook::jsi::Runtime& runtime) {
            auto payload = facebook::jsi::Object(runtime);

            // Create nativeEvent with touch coordinates
            auto nativeEvent = facebook::jsi::Object(runtime);
            nativeEvent.setProperty(runtime, "pageX", x);
            nativeEvent.setProperty(runtime, "pageY", y);
            nativeEvent.setProperty(runtime, "locationX", x);
            nativeEvent.setProperty(runtime, "locationY", y);
            nativeEvent.setProperty(runtime, "target", 0);
            nativeEvent.setProperty(runtime, "identifier", 0);
            nativeEvent.setProperty(runtime, "timestamp", static_cast<double>(
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()
                ).count()
            ));

            payload.setProperty(runtime, "nativeEvent", nativeEvent);
            return payload;
        }
    );
}

void EventDispatcher::dispatchResponderEvent(
    facebook::react::SharedEventEmitter emitter,
    const std::string& eventType,
    float x,
    float y
) {
    if (!emitter) {
        return;
    }

    // Dispatch responder events (responderGrant, responderRelease, etc.)
    // These are the events that drive TouchableOpacity/Pressable behavior
    emitter->dispatchEvent(
        eventType,
        [x, y](facebook::jsi::Runtime& runtime) {
            auto payload = facebook::jsi::Object(runtime);

            // Create nativeEvent with touch coordinates
            auto nativeEvent = facebook::jsi::Object(runtime);
            nativeEvent.setProperty(runtime, "pageX", x);
            nativeEvent.setProperty(runtime, "pageY", y);
            nativeEvent.setProperty(runtime, "locationX", x);
            nativeEvent.setProperty(runtime, "locationY", y);
            nativeEvent.setProperty(runtime, "target", 0);
            nativeEvent.setProperty(runtime, "identifier", 0);
            nativeEvent.setProperty(runtime, "timestamp", static_cast<double>(
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()
                ).count()
            ));

            // Create touches array for responder events
            auto touches = facebook::jsi::Array(runtime, 1);
            auto touch = facebook::jsi::Object(runtime);
            touch.setProperty(runtime, "pageX", x);
            touch.setProperty(runtime, "pageY", y);
            touch.setProperty(runtime, "locationX", x);
            touch.setProperty(runtime, "locationY", y);
            touch.setProperty(runtime, "identifier", 0);
            touch.setProperty(runtime, "target", 0);
            touches.setValueAtIndex(runtime, 0, touch);

            payload.setProperty(runtime, "nativeEvent", nativeEvent);
            payload.setProperty(runtime, "touches", touches);
            payload.setProperty(runtime, "changedTouches", touches);

            return payload;
        }
    );
}

void EventDispatcher::dispatchScrollEvent(
    facebook::react::SharedEventEmitter emitter,
    float deltaX,
    float deltaY
) {
    if (!emitter) {
        return;
    }

    // Dispatch scroll event for ScrollView components
    emitter->dispatchEvent(
        "scroll",
        [deltaX, deltaY](facebook::jsi::Runtime& runtime) {
            auto payload = facebook::jsi::Object(runtime);

            auto contentOffset = facebook::jsi::Object(runtime);
            contentOffset.setProperty(runtime, "x", deltaX);
            contentOffset.setProperty(runtime, "y", deltaY);

            auto contentSize = facebook::jsi::Object(runtime);
            contentSize.setProperty(runtime, "width", 0.0);
            contentSize.setProperty(runtime, "height", 0.0);

            auto layoutMeasurement = facebook::jsi::Object(runtime);
            layoutMeasurement.setProperty(runtime, "width", 0.0);
            layoutMeasurement.setProperty(runtime, "height", 0.0);

            payload.setProperty(runtime, "contentOffset", contentOffset);
            payload.setProperty(runtime, "contentSize", contentSize);
            payload.setProperty(runtime, "layoutMeasurement", layoutMeasurement);

            return payload;
        }
    );
}

void EventDispatcher::dispatchTextChangeEvent(
    facebook::react::SharedEventEmitter emitter,
    const std::string& text
) {
    if (!emitter) {
        return;
    }

    // Dispatch changeText event for TextInput components
    // This is the event that triggers onChangeText in React Native
    emitter->dispatchEvent(
        "changeText",
        [text](facebook::jsi::Runtime& runtime) {
            // For changeText, the payload is just the text string
            return facebook::jsi::String::createFromUtf8(runtime, text);
        }
    );

    // Also dispatch change event with nativeEvent structure
    emitter->dispatchEvent(
        "change",
        [text](facebook::jsi::Runtime& runtime) {
            auto payload = facebook::jsi::Object(runtime);
            auto nativeEvent = facebook::jsi::Object(runtime);
            nativeEvent.setProperty(runtime, "text", facebook::jsi::String::createFromUtf8(runtime, text));
            nativeEvent.setProperty(runtime, "eventCount", 0);
            payload.setProperty(runtime, "nativeEvent", nativeEvent);
            return payload;
        }
    );
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
