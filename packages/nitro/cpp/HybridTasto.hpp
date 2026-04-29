#pragma once

// Include the generated spec
#include "../nitrogen/generated/shared/c++/HybridTastoSpec.hpp"

#include <memory>
#include <string>

namespace margelo::nitro::tasto {

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

private:
    bool serverRunning_ = false;
    int serverPort_ = 0;
};

} // namespace margelo::nitro::tasto
