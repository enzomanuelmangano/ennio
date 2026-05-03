#pragma once

#include <memory>
#include <string>

#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/core/EventEmitter.h>

namespace ennio {

/**
 * Scroll direction for swipe/scroll operations
 */
enum class ScrollDirection {
    Up,
    Down,
    Left,
    Right
};

/**
 * EventDispatcher handles firing events on React Native components
 * through the Fabric event system.
 */
class EventDispatcher {
public:
    using ShadowNodePtr = std::shared_ptr<const facebook::react::ShadowNode>;

    /**
     * Simulate a tap (press) on an element
     * Fires: onPressIn -> onPress -> onPressOut
     */
    static bool tap(ShadowNodePtr node);

    /**
     * Simulate a double tap on an element
     * Two taps with 50ms delay between them
     */
    static bool doubleTap(ShadowNodePtr node);

    /**
     * Simulate a long press on an element
     * @param durationMs - Duration of the press in milliseconds
     */
    static bool longPress(ShadowNodePtr node, int durationMs);

    /**
     * Type text into a TextInput
     * Fires: onChangeText with each character, then final text
     */
    static bool typeText(ShadowNodePtr node, const std::string& text);

    /**
     * Clear text from a TextInput
     * Fires: onChangeText with empty string
     */
    static bool clearText(ShadowNodePtr node);

    /**
     * Replace text in a TextInput
     * Fires: onChangeText with new text
     */
    static bool replaceText(ShadowNodePtr node, const std::string& text);

    /**
     * Scroll a ScrollView by delta values
     * Fires: onScrollBeginDrag -> onScroll -> onScrollEndDrag
     */
    static bool scroll(ShadowNodePtr node, float deltaX, float deltaY);

    /**
     * Scroll to bring a child element into view
     */
    static bool scrollTo(
        ShadowNodePtr scrollView,
        ShadowNodePtr targetElement
    );

    /**
     * Scroll to a specific index in a list
     */
    static bool scrollToIndex(ShadowNodePtr listNode, int index);

    /**
     * Perform a swipe gesture
     */
    static bool swipe(
        ShadowNodePtr node,
        ScrollDirection direction,
        float distance
    );

    /**
     * Focus a TextInput
     * Fires: onFocus
     */
    static bool focus(ShadowNodePtr node);

    /**
     * Blur (unfocus) a TextInput
     * Fires: onBlur
     */
    static bool blur(ShadowNodePtr node);

private:
    /**
     * Get the EventEmitter from a ShadowNode
     */
    static facebook::react::SharedEventEmitter getEventEmitter(ShadowNodePtr node);

    /**
     * Dispatch a native touch event (touchStart, touchEnd, touchMove, touchCancel)
     * These are the raw touch events that drive the responder system
     */
    static void dispatchTouchEvent(
        facebook::react::SharedEventEmitter emitter,
        const std::string& eventType,
        float x,
        float y,
        int32_t target,
        double timestamp
    );

    /**
     * Dispatch a click event (triggers onPress in Pressable)
     */
    static void dispatchClickEvent(
        facebook::react::SharedEventEmitter emitter,
        float x,
        float y
    );

    /**
     * Dispatch a press event (pressIn, press, pressOut)
     * These are the events used by Pressable components
     */
    static void dispatchPressEvent(
        facebook::react::SharedEventEmitter emitter,
        const std::string& eventType,
        float x,
        float y
    );

    /**
     * Dispatch a responder event (responderGrant, responderRelease, etc.)
     * These are the events that drive TouchableOpacity behavior
     */
    static void dispatchResponderEvent(
        facebook::react::SharedEventEmitter emitter,
        const std::string& eventType,
        float x,
        float y
    );

    /**
     * Dispatch a scroll event for ScrollView components
     */
    static void dispatchScrollEvent(
        facebook::react::SharedEventEmitter emitter,
        float deltaX,
        float deltaY
    );

    /**
     * Dispatch a text change event for TextInput components
     */
    static void dispatchTextChangeEvent(
        facebook::react::SharedEventEmitter emitter,
        const std::string& text
    );

    /**
     * Get center point of a node for touch events
     */
    static std::pair<float, float> getCenterPoint(ShadowNodePtr node);
};

} // namespace ennio
