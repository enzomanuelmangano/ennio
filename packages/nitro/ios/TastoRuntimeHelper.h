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
