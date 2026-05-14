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
#include "Protocol.hpp"
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
    // Element Queries
    // ============================================
    bool exists(const std::string& testID) override;
    bool isVisible(const std::string& testID) override;
    std::variant<nitro::NullType, std::string> getText(const std::string& testID) override;

    // ============================================
    // Synchronization
    // ============================================
    bool waitForIdle(double timeoutMs) override;
    void synchronize() override;

    // Wake the moment React fires onCommitFiberRoot, capped at maxMs.
    // Replaces blind sleep settles in the CLI with an early-wake; cap
    // is the safety floor so the worst case is identical to a sleep.
    bool waitForNextCommit(double maxMs) override;

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
    bool scroll(const std::string& testID, ScrollDirection direction, double distance) override;
    bool scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID) override;
    bool swipeAtPoints(double x1, double y1, double x2, double y2, double durationMs) override;
    bool pressHardwareKey(double keyCode) override;
    bool backGesture() override;
    bool hideKeyboard() override;
    bool tapAlertButton(const std::string& buttonText) override;
    bool dismissAlert() override;
    bool copyToClipboard(const std::string& text) override;
    bool pasteFromClipboard(const std::string& testID) override;

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
     * JS-thread executor — wraps `RCTInstance.callFunctionOnBufferedRuntimeExecutor:`
     * (or any equivalent scheduler) so background dispatch worker
     * threads can schedule result-writes back onto JS. Stored once
     * during bootstrap by `EnnioAutoInit`.
     */
    using JSThreadExecutor = std::function<void(std::function<void(facebook::jsi::Runtime&)>&&)>;
    static void setJSThreadExecutor(JSThreadExecutor exec);

    /**
     * Pure-native bootstrap. Called from `EnnioAutoInit`'s post-start
     * hook on the JS thread (after the runtime is initialised).
     * Captures the runtime, evaluates the commit-signal walker, installs
     * `__ennioDispatch` JSI host function so the external CLI can drive
     * the runner via Hermes Inspector `Runtime.evaluate`. Idempotent.
     */
    static void nativeBootstrap(facebook::jsi::Runtime& runtime);


private:
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
     * Run one request through the central command table. Same path is
     * driven from JSI (`__ennioDispatch`) — the CLI hands us a Request
     * over Hermes Inspector CDP and we hand back a Response.
     */
    ::ennio::Response handleCommand(const ::ennio::Request& request);

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
