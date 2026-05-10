//
// EnnioRuntimeHelper.h
// Provides access to React Native runtime and UIManager for Ennio
//

#pragma once

#ifdef __OBJC__
@class RCTSurfacePresenter;
#endif

#ifdef __cplusplus

#include <memory>
#include <string>
#include <vector>

namespace facebook {
namespace react {
    class UIManager;
    class ShadowNode;
} // namespace react
} // namespace facebook

namespace ennio {

/**
 * EnnioRuntimeHelper - Singleton for accessing React Native's UIManager
 *
 * This class bridges iOS's RCTSurfacePresenter to C++ code that needs
 * access to the shadow tree.
 */
class EnnioRuntimeHelper {
public:
    static EnnioRuntimeHelper& getInstance();

    /**
     * Set the surface presenter (called from Objective-C during app startup)
     */
    void setSurfacePresenter(void* surfacePresenter);

    /**
     * Get the UIManager for shadow tree access
     * Returns nullptr if not yet initialized
     */
    std::shared_ptr<facebook::react::UIManager> getUIManager();

    /**
     * Get the current shadow tree root for the default surface
     */
    std::shared_ptr<const facebook::react::ShadowNode> getShadowTreeRoot();

    /**
     * Check if the helper is properly initialized
     */
    bool isInitialized() const;

    // ============================================
    // Alert/Modal Handling
    // ============================================

    /**
     * Check if an alert is currently presented
     */
    bool isAlertPresent();

    /**
     * Get the text content of the current alert (title + message)
     */
    std::string getAlertText();

    /**
     * Get the list of button titles in the current alert
     */
    std::vector<std::string> getAlertButtons();

    // ============================================
    // Fast-mode Writes
    //
    // Each method finds a UIView via accessibilityIdentifier (RN testID)
    // and drives the action directly through UIKit / iOS accessibility
    // APIs. No XCUI helper, no synthetic touches. Per-call latency is
    // dominated by the view-tree DFS (~5ms on the example app); no
    // cross-process IPC, no animation race.
    // ============================================

    bool tap(const std::string& testID);
    bool tapByLabel(const std::string& text);
    /**
     * Tap at an absolute window-coordinate point (logical pt, not pixels).
     * Synthesises a UITouch sequence so UIKit's hit-test routes the
     * gesture through the responder chain. Used by tapBySelector when a
     * shadow-tree match resolves to a layout instead of a UIView with a
     * testID.
     */
    bool tapAtScreenPoint(double x, double y);

    /**
     * Synthesise a pan gesture from (x1,y1) to (x2,y2) over `durationMs`.
     * Fast path when the start point hits a UIScrollView ancestor:
     * setContentOffset with the delta, no UITouch tax. Otherwise drives
     * a UITouchPhaseMoved loop along the line. Window-coords (logical pt).
     * Sim-only.
     */
    bool swipeAtPoints(double x1, double y1, double x2, double y2, double durationMs);

    /**
     * Synthesise a hardware key press by HID keycode against the current
     * first responder when it conforms to UIKeyInput. Mapped: 42=backspace,
     * 40=return, 44=space. Returns false when no input field is focused.
     */
    bool pressHardwareKey(double keyCode);
    /**
     * Origin of the React surface inside the user app's window, in
     * logical points. Adds to Fabric's surface-relative screenX/screenY
     * to get window-relative coords idb can tap on.
     */
    std::pair<double, double> getSurfaceOffset();
    /**
     * Logical-point bounds of the key UIWindow. (width, height) — origin
     * is always (0,0). Used by tap-time visibility gates: a view whose
     * window-frame falls fully outside this rect is unreachable by a
     * real finger and should fail the tap.
     */
    std::pair<double, double> getKeyWindowSize();
    /**
     * Returns true iff the testID-bearing view exists, has non-zero size,
     * and overlaps the key window's visible bounds. Mirrors what a real
     * finger could reach: an offscreen / not-yet-laid-out element returns
     * false. Skips the gesture / responder tree — purely a layout check.
     */
    bool isViewOnscreen(const std::string& testID);
    /**
     * Window-relative frame of the UIView with the given testID. Returns
     * (x, y, w, h) all in logical points. Width/height = 0 when not
     * found. This bypasses Fabric's surface-relative layout entirely:
     * the value already accounts for ScrollView contentInsetAdjustment,
     * safe-area padding, and any other UIKit-runtime offsets.
     */
    std::tuple<double, double, double, double> getViewWindowFrame(const std::string& testID);
    /**
     * Window-relative frame for the first UIView whose accessibilityLabel
     * matches `text` (substring). Used for native widgets that don't show
     * up in the Fabric tree — UITabBar items, alert buttons, system
     * sheets, RNScreens stack headers.
     */
    std::tuple<double, double, double, double> getViewWindowFrameByLabel(const std::string& text);
    /**
     * True if the testID's UIView (or any ancestor) is a UIButton with
     * `menu` set + `showsMenuAsPrimaryAction` (zeego DropdownMenu,
     * react-native-ios-context-menu). Such triggers cannot be opened by
     * UIControl.sendActions or programmatic _presentMenuAtLocation: in
     * the host app — only by real HID input. Caller routes through idb.
     */
    bool isMenuTriggerAncestor(const std::string& testID);
    bool doubleTap(const std::string& testID);
    bool longPress(const std::string& testID, int durationMs);
    bool typeText(const std::string& testID, const std::string& text);
    bool clearText(const std::string& testID);
    bool eraseText(const std::string& testID, int count);
    bool pressKey(const std::string& testID, const std::string& keyName);
    bool scroll(const std::string& testID, const std::string& direction, double distance);
    bool swipe(const std::string& testID, const std::string& direction, double distance);
    bool scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID);
    bool tapTab(int index);
    /**
     * Find a UITabBarController in any window scene and select the tab
     * whose viewController's title (or tabBarItem.title) matches `name`
     * case-insensitively. Used when NativeTabs renders bar items via
     * SwiftUI / UIKit hosts that don't surface their UIView subtree to
     * accessibility-label walks. Returns false if no matching tab.
     */
    bool tapTabByName(const std::string& name);
    /**
     * One-shot tap-readiness query. Returns the window-coord frame for
     * `testID` only after iOS is in a state where the next touch will
     * actually deliver: no UIPresentationController / UINavigation
     * transition is in flight, no alert-level UIWindow is sitting on
     * top, the target's userInteractionEnabled chain is clean. Polls
     * in-process every ~20 ms up to `maxWaitMs`; the JS / CLI side pays
     * a single WS round-trip regardless of wait duration. Returns
     * (0,0,0,0) on timeout. Library-agnostic — works for Pressable,
     * TouchableOpacity, RNGH BaseButton, pressto, anything that hangs
     * its handler off iOS's responder + recognizer pipeline.
     */
    std::tuple<double, double, double, double> getReadyCoord(const std::string& testID, int maxWaitMs);
    /**
     * Library-agnostic tap that bypasses iOS HID + gesture coordinator.
     * Cascades through three direct-fire paths against the testID's
     * UIView:
     *   1. nearest enabled UIControl ancestor → sendActions touchUpInside
     *      (UIButton, UISwitch, RNGestureHandlerButton)
     *   2. gestureRecognizers on view + ancestors driven by direct
     *      touchesBegan: / touchesEnded: calls (RCTSurfaceTouchHandler →
     *      RN responder release → Pressable/Touchable onPress;
     *      RNNativeViewGestureRecognizer → RNGH onActivated → user onPress)
     *   3. accessibilityActivate (a11y-tagged buttons)
     * Returns true if any path fired. Caller falls back to idb HID on
     * false (covers pure-native UIAlertController buttons et al).
     */
    bool fireTapByTestID(const std::string& testID);
    bool backGesture();
    bool hideKeyboard();
    bool tapAlertButton(const std::string& buttonText);
    bool dismissAlert();
    bool copyToClipboard(const std::string& text);
    bool pasteFromClipboard(const std::string& testID);
    std::string getClipboardText();

private:
    EnnioRuntimeHelper() = default;
    ~EnnioRuntimeHelper() = default;
    EnnioRuntimeHelper(const EnnioRuntimeHelper&) = delete;
    EnnioRuntimeHelper& operator=(const EnnioRuntimeHelper&) = delete;

    void* surfacePresenter_ = nullptr;
};

} // namespace ennio

#endif // __cplusplus

// C function for Objective-C code to call
#ifdef __cplusplus
extern "C" {
#endif

#ifdef __OBJC__
void EnnioSetSurfacePresenter(RCTSurfacePresenter* _Nonnull presenter);
#endif

#ifdef __cplusplus
}
#endif
