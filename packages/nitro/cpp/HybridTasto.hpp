#pragma once

// Include the generated spec
#include "../nitrogen/generated/shared/c++/HybridTastoSpec.hpp"

#include <memory>
#include <string>
#include <vector>
#include <functional>
#include <mutex>

// React Native Fabric headers
#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/uimanager/UIManager.h>

// Internal components
#include "WebSocketServer.hpp"
#include "TestIDRegistry.hpp"
#include "ShadowTreeTraverser.hpp"
#include "EventDispatcher.hpp"

namespace margelo::nitro::tasto {

using ShadowNodePtr = std::shared_ptr<const facebook::react::ShadowNode>;
using RuntimeExecutor = std::function<void(std::function<void(facebook::jsi::Runtime&)>&&)>;

/**
 * HybridTasto - Main Nitro HybridObject for E2E testing
 *
 * Provides direct access to React Native's Fabric shadow tree
 * for fast, reliable E2E testing without instrumentation.
 */
class HybridTasto : public HybridTastoSpec {
public:
    HybridTasto();
    ~HybridTasto() override = default;

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
    // Actions
    // ============================================
    bool tap(const std::string& testID) override;
    bool longPress(const std::string& testID, double durationMs) override;
    bool typeText(const std::string& testID, const std::string& text) override;
    bool clearText(const std::string& testID) override;
    bool replaceText(const std::string& testID, const std::string& text) override;
    bool scroll(const std::string& testID, double deltaX, double deltaY) override;
    bool scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID) override;
    bool scrollToIndex(const std::string& testID, double index) override;
    bool swipe(const std::string& testID, ScrollDirection direction, double distance) override;

    // ============================================
    // Synchronization
    // ============================================
    bool waitForIdle(double timeoutMs) override;
    void synchronize() override;

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

private:
    // Server state
    bool serverRunning_ = false;
    int serverPort_ = 0;
    std::unique_ptr<::tasto::WebSocketServer> webSocketServer_;

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
    ::tasto::Response handleCommand(const ::tasto::Request& request);

    /**
     * Convert internal ElementInfo to Nitro struct
     */
    ElementInfo convertElementInfo(const ::tasto::ElementInfo& info) const;

    /**
     * Convert internal LayoutMetrics to Nitro struct
     */
    LayoutMetrics convertLayoutMetrics(const ::tasto::LayoutMetrics& metrics) const;

    // ============================================
    // Alert/Modal Handling (WebSocket only)
    // ============================================

    /**
     * Check if an alert is currently present
     */
    bool isAlertPresent();

    /**
     * Get the text of the current alert (title + message)
     */
    std::string getAlertText();

    /**
     * Get the button titles of the current alert
     */
    std::vector<std::string> getAlertButtons();

    /**
     * Tap an alert button by its text
     */
    bool tapAlertButton(const std::string& buttonText);

    /**
     * Dismiss the current alert
     */
    bool dismissAlert();
};

} // namespace margelo::nitro::tasto
