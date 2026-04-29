#pragma once

#include <memory>
#include <string>

#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/core/EventEmitter.h>

namespace tasto {

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
     * Dispatch a touch event (touchStart, touchMove, touchEnd)
     */
    static void dispatchTouchEvent(
        facebook::react::SharedEventEmitter emitter,
        const std::string& eventType,
        float x,
        float y
    );

    /**
     * Get center point of a node for touch events
     */
    static std::pair<float, float> getCenterPoint(ShadowNodePtr node);
};

} // namespace tasto
