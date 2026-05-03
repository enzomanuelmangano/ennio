//
// TastoRuntimeHelper.h
// Provides access to React Native runtime and UIManager for Tasto
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

namespace tasto {

/**
 * TastoRuntimeHelper - Singleton for accessing React Native's UIManager
 *
 * This class bridges iOS's RCTSurfacePresenter to C++ code that needs
 * access to the shadow tree.
 */
class TastoRuntimeHelper {
public:
    static TastoRuntimeHelper& getInstance();

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

    /**
     * Perform a native tap at the given screen coordinates
     * Uses iOS accessibility and gesture systems
     */
    bool performTap(float x, float y);

    /**
     * Perform a native tap by finding the view with the given testID (accessibilityIdentifier)
     * This is more reliable for modal elements where shadow tree coordinates may not match native positions
     */
    bool performTapByTestID(const std::string& testID);

    /**
     * Perform a native tap by finding the view with the given accessibility label (text)
     * This is used for native iOS elements like tab bars that aren't in the React Native shadow tree
     */
    bool performTapByLabel(const std::string& label);

    /**
     * Type text into a text input with the given testID
     * Uses native iOS text input APIs to properly trigger React Native's onChange
     */
    bool performTypeText(const std::string& testID, const std::string& text);

    /**
     * Type text into a text input at the given screen coordinates
     * Uses hitTest to find the text input at that position
     */
    bool performTypeTextAtPoint(float x, float y, const std::string& text);

    /**
     * Clear text from a text input with the given testID
     */
    bool performClearText(const std::string& testID);

    /**
     * Clear text from a text input at the given screen coordinates
     */
    bool performClearTextAtPoint(float x, float y);

    // ============================================
    // Scroll Handling
    // ============================================

    /**
     * Scroll a ScrollView by delta values
     * Returns true if successful
     */
    bool performScroll(const std::string& testID, float deltaX, float deltaY);

    /**
     * Scroll a ScrollView to a specific offset
     * Returns true if successful
     */
    bool performScrollTo(const std::string& testID, float x, float y, bool animated);

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

    /**
     * Tap an alert button by its text
     * Returns true if successful
     */
    bool tapAlertButton(const std::string& buttonText);

    /**
     * Dismiss the current alert (taps the cancel/OK button)
     */
    bool dismissAlert();

private:
    TastoRuntimeHelper() = default;
    ~TastoRuntimeHelper() = default;
    TastoRuntimeHelper(const TastoRuntimeHelper&) = delete;
    TastoRuntimeHelper& operator=(const TastoRuntimeHelper&) = delete;

    void* surfacePresenter_ = nullptr;
};

} // namespace tasto

#endif // __cplusplus

// C function for Objective-C code to call
#ifdef __cplusplus
extern "C" {
#endif

#ifdef __OBJC__
void TastoSetSurfacePresenter(RCTSurfacePresenter* _Nonnull presenter);
#endif

#ifdef __cplusplus
}
#endif
