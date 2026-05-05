#pragma once

// Include the generated spec
#include "../nitrogen/generated/shared/c++/HybridEnnioSpec.hpp"

#include <memory>
#include <string>
#include <vector>
#include <functional>
#include <mutex>

// React Native Fabric headers
#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/uimanager/UIManager.h>

// JSI for runtime + dispatcher access
#include <jsi/jsi.h>

namespace margelo::nitro { class Dispatcher; }

// Internal components
#include "WebSocketServer.hpp"
#include "TestIDRegistry.hpp"
#include "ShadowTreeTraverser.hpp"
#include "SelectorCriteria.hpp"
#include "SelectorParser.hpp"
#include "ElementMatcher.hpp"

namespace margelo::nitro::ennio {

using ShadowNodePtr = std::shared_ptr<const facebook::react::ShadowNode>;
using RuntimeExecutor = std::function<void(std::function<void(facebook::jsi::Runtime&)>&&)>;

/**
 * HybridEnnio - Main Nitro HybridObject for E2E testing
 *
 * Provides direct access to React Native's Fabric shadow tree
 * for fast, reliable E2E testing without instrumentation.
 */
class HybridEnnio : public HybridEnnioSpec {
public:
    HybridEnnio();
    ~HybridEnnio() override = default;

    // ============================================
    // Server Management
    // ============================================
    void startServer(double port) override;
    void stopServer() override;
    bool isServerRunning() override;

    // ============================================
    // Element Queries
    // ============================================
    std::variant<nitro::NullType, ElementInfo> findByTestID(const std::string& testID) override;
    bool exists(const std::string& testID) override;
    std::variant<nitro::NullType, LayoutMetrics> getLayoutMetrics(const std::string& testID) override;
    bool isVisible(const std::string& testID) override;
    std::variant<nitro::NullType, std::string> getText(const std::string& testID) override;

    // ============================================
    // Synchronization
    // ============================================
    bool waitForIdle(double timeoutMs) override;
    void synchronize() override;

    // ============================================
    // Selector-based Queries (Full Maestro Parity)
    // ============================================
    std::variant<nitro::NullType, ExtendedElementInfo> findBySelector(const std::string& selectorJson) override;
    std::vector<ExtendedElementInfo> findAllBySelector(const std::string& selectorJson) override;
    bool existsBySelector(const std::string& selectorJson) override;
    std::variant<nitro::NullType, std::string> getTextBySelector(const std::string& selectorJson) override;
    bool isVisibleBySelector(const std::string& selectorJson) override;

    // ============================================
    // Alert/Modal Handling
    // ============================================
    bool isAlertPresent() override;
    std::string getAlertText() override;
    std::vector<std::string> getAlertButtons() override;

    // ============================================
    // Fast-mode Writes
    // ============================================
    bool tap(const std::string& testID) override;
    bool tapByLabel(const std::string& text) override;
    bool doubleTap(const std::string& testID) override;
    bool longPress(const std::string& testID, double durationMs) override;
    bool typeText(const std::string& testID, const std::string& text) override;
    bool clearText(const std::string& testID) override;
    bool eraseText(const std::string& testID, double count) override;
    bool pressKey(const std::string& testID, const std::string& keyName) override;
    bool scroll(const std::string& testID, ScrollDirection direction, double distance) override;
    bool swipe(const std::string& testID, ScrollDirection direction, double distance) override;
    bool scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID) override;
    bool tapTab(double index) override;
    bool backGesture() override;
    bool hideKeyboard() override;
    bool tapBySelector(const std::string& selectorJson) override;
    bool doubleTapBySelector(const std::string& selectorJson) override;
    bool longPressBySelector(const std::string& selectorJson, double durationMs) override;
    bool typeTextBySelector(const std::string& selectorJson, const std::string& text) override;
    bool clearTextBySelector(const std::string& selectorJson) override;
    bool tapAlertButton(const std::string& buttonText) override;
    bool dismissAlert() override;
    bool copyToClipboard(const std::string& text) override;
    bool pasteFromClipboard(const std::string& testID) override;
    std::string getClipboardText() override;

    // ============================================
    // Initialization (called from JS)
    // ============================================

    /**
     * Initialize with UIManager reference for shadow tree access
     * Must be called before using query/action methods
     */
    void initialize(
        std::weak_ptr<facebook::react::UIManager> uiManager,
        facebook::react::SurfaceId surfaceId
    );

    /**
     * Check if the module is properly initialized
     */
    bool isInitialized() const;

    /**
     * Drive a synthetic onPress on the React fiber whose `testID`
     * matches. Blocks the calling (WS-server) thread until the JS
     * thread finishes the walk or the timeout (1500 ms) elapses.
     */
    static bool invokeOnPressFromCpp(const std::string& testID);

    /**
     * JS-thread executor — wraps `RCTInstance.callFunctionOnBufferedRuntimeExecutor:`
     * (or any equivalent scheduler) so the WS-server thread can
     * dispatch fiber-walks back onto JS. Stored once during bootstrap.
     */
    using JSThreadExecutor = std::function<void(std::function<void(facebook::jsi::Runtime&)>&&)>;
    static void setJSThreadExecutor(JSThreadExecutor exec);

    /**
     * Pure-native bootstrap. Called from `EnnioAutoInit`'s post-start
     * hook on the JS thread (after the runtime is initialised).
     * Captures the runtime, evaluates the Fiber walker into globalThis,
     * constructs a singleton HybridEnnio + starts the WebSocket server.
     * Idempotent.
     */
    static void nativeBootstrap(facebook::jsi::Runtime& runtime, int port);


private:
    // Server state
    bool serverRunning_ = false;
    int serverPort_ = 0;
    std::unique_ptr<::ennio::WebSocketServer> webSocketServer_;

    // Shadow tree access
    std::weak_ptr<facebook::react::UIManager> uiManager_;
    facebook::react::SurfaceId surfaceId_ = 0;
    mutable std::mutex mutex_;

    // Screen dimensions for visibility checks
    float screenWidth_ = 0;
    float screenHeight_ = 0;

    /**
     * Get the current shadow tree root for the surface
     */
    ShadowNodePtr getShadowTreeRoot() const;

    /**
     * Find a node by testID using registry or tree traversal
     */
    ShadowNodePtr findNode(const std::string& testID) const;

    /**
     * Handle incoming WebSocket commands
     */
    ::ennio::Response handleCommand(const ::ennio::Request& request);

    /**
     * Convert internal ElementInfo to Nitro struct
     */
    ElementInfo convertElementInfo(const ::ennio::ElementInfo& info) const;

    /**
     * Convert internal LayoutMetrics to Nitro struct
     */
    LayoutMetrics convertLayoutMetrics(const ::ennio::LayoutMetrics& metrics) const;

    /**
     * Convert internal ExtendedElementInfo to Nitro struct
     */
    ExtendedElementInfo convertExtendedElementInfo(const ::ennio::ExtendedElementInfo& info) const;

    /**
     * Find a node by selector criteria
     */
    ShadowNodePtr findNodeBySelector(const ::ennio::SelectorCriteria& criteria) const;

};

} // namespace margelo::nitro::ennio
