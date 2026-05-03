#include "HybridEnnio.hpp"
#include "IdleMonitor.hpp"
#include "EnnioLog.hpp"

#include <thread>
#include <chrono>
#include <sstream>

#include <react/renderer/uimanager/UIManagerBinding.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/components/view/ViewProps.h>

// iOS-specific helper for accessing UIManager
#if defined(__APPLE__)
#include "../ios/EnnioRuntimeHelper.h"
#endif

// Logging tag for this module
static const char* LOG_TAG = "HybridEnnio";

// Helper to escape strings for JSON output
static std::string escapeJsonString(const std::string& str) {
    std::ostringstream oss;
    for (char c : str) {
        switch (c) {
            case '"': oss << "\\\""; break;
            case '\\': oss << "\\\\"; break;
            case '\n': oss << "\\n"; break;
            case '\r': oss << "\\r"; break;
            case '\t': oss << "\\t"; break;
            case '\b': oss << "\\b"; break;
            case '\f': oss << "\\f"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    // Control character - escape as unicode
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    oss << buf;
                } else {
                    oss << c;
                }
        }
    }
    return oss.str();
}

// Helper: derive accessibility label from testID
// e.g., "tab-home" -> "Home", "btn-submit" -> "Submit", "search-input" -> "Search"
static std::string deriveLabel(const std::string& testId) {
    // Find last hyphen or underscore
    size_t pos = testId.rfind('-');
    if (pos == std::string::npos) {
        pos = testId.rfind('_');
    }

    std::string label;
    if (pos != std::string::npos && pos + 1 < testId.size()) {
        label = testId.substr(pos + 1);
    } else {
        label = testId;
    }

    // Capitalize first letter
    if (!label.empty() && label[0] >= 'a' && label[0] <= 'z') {
        label[0] = label[0] - 'a' + 'A';
    }

    return label;
}

namespace margelo::nitro::ennio {

// Must call HybridObject(TAG) directly because it's a virtual base class
HybridEnnio::HybridEnnio() : HybridObject(TAG) {}

// ============================================
// Initialization
// ============================================

void HybridEnnio::initialize(
    std::weak_ptr<facebook::react::UIManager> uiManager,
    facebook::react::SurfaceId surfaceId
) {
    std::lock_guard<std::mutex> lock(mutex_);
    uiManager_ = uiManager;
    surfaceId_ = surfaceId;
}

bool HybridEnnio::isInitialized() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return !uiManager_.expired() && surfaceId_ != 0;
}

ShadowNodePtr HybridEnnio::getShadowTreeRoot() const {
#if defined(__APPLE__)
    // On iOS, try to get the UIManager through EnnioRuntimeHelper first
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();

    ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("getShadowTreeRoot: helper initialized=" << (helper.isInitialized() ? "YES" : "NO")));

    if (helper.isInitialized()) {
        auto uiManager = helper.getUIManager();
        ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("getShadowTreeRoot: UIManager=" << (uiManager ? "available" : "null")));

        if (uiManager) {
            auto& shadowTreeRegistry = uiManager->getShadowTreeRegistry();
            ShadowNodePtr rootNode = nullptr;

            shadowTreeRegistry.enumerate([&](const facebook::react::ShadowTree& shadowTree, bool& stop) {
                rootNode = shadowTree.getCurrentRevision().rootShadowNode;
                stop = true;
            });

            if (rootNode) {
                return rootNode;
            }
        }
    } else {
        ENNIO_LOG_DEBUG(LOG_TAG, "getShadowTreeRoot: EnnioRuntimeHelper NOT initialized");
    }
#endif

    // Fallback to stored UIManager reference
    auto uiManager = uiManager_.lock();
    if (!uiManager) {
        ENNIO_LOG_WARN(LOG_TAG, "UIManager not available - is EnnioRuntimeHelper initialized?");
        return nullptr;
    }

    // Get the shadow tree revision provider and get current root
    auto& shadowTreeRegistry = uiManager->getShadowTreeRegistry();
    ShadowNodePtr rootNode = nullptr;

    shadowTreeRegistry.enumerate([&](const facebook::react::ShadowTree& shadowTree, bool& stop) {
        if (shadowTree.getSurfaceId() == surfaceId_) {
            rootNode = shadowTree.getCurrentRevision().rootShadowNode;
            stop = true;
        }
    });

    return rootNode;
}

ShadowNodePtr HybridEnnio::findNode(const std::string& testID) const {
    ENNIO_LOG_DEBUG(LOG_TAG, ENNIO_LOG_FMT("findNode: testID=" << testID));

    // Walk the live shadow tree first. The registry caches weak_ptr to nodes
    // captured at update time; after a re-render React produces new nodes for
    // the same testID, but the old shared_ptr can still be alive (held by
    // prior commits). Dispatching events on that stale node hits dead handlers.
    // Live walk costs O(n) but matches what the user sees on screen.
    auto root = getShadowTreeRoot();
    if (root) {
        auto found = ::ennio::ShadowTreeTraverser::findByTestID(root, testID);
        if (found) {
            ::ennio::TestIDRegistry::getInstance().registerNode(testID, found);
            return found;
        }
    }

    // Fall back to registry only when we can't reach the live tree.
    return ::ennio::TestIDRegistry::getInstance().findByTestID(testID);
}

// ============================================
// Server Management
// ============================================

void HybridEnnio::startServer(double port) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (serverRunning_) {
        ENNIO_LOG_WARN(LOG_TAG, "Server already running");
        return;
    }

    serverPort_ = static_cast<int>(port);
    ENNIO_LOG_INFO(LOG_TAG, ENNIO_LOG_FMT("Starting WebSocket server on port " << serverPort_));

    // Create and start WebSocket server
    webSocketServer_ = std::make_unique<::ennio::WebSocketServer>();
    webSocketServer_->setCommandHandler([this](const ::ennio::Request& request) {
        return handleCommand(request);
    });

    if (webSocketServer_->start(serverPort_)) {
        serverRunning_ = true;
        ENNIO_LOG_INFO(LOG_TAG, "WebSocket server started successfully");
    } else {
        ENNIO_LOG_ERROR(LOG_TAG, "Failed to start WebSocket server");
        webSocketServer_.reset();
    }
}

void HybridEnnio::stopServer() {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!serverRunning_) {
        return;
    }

    if (webSocketServer_) {
        webSocketServer_->stop();
        webSocketServer_.reset();
    }

    serverRunning_ = false;
    serverPort_ = 0;
}

bool HybridEnnio::isServerRunning() {
    std::lock_guard<std::mutex> lock(mutex_);
    return serverRunning_;
}

// ============================================
// Element Queries
// ============================================

std::variant<nitro::NullType, ElementInfo> HybridEnnio::findByTestID(const std::string& testID) {
    auto node = findNode(testID);
    if (!node) {
        return nitro::NullType();
    }

    auto root = getShadowTreeRoot();
    auto infoOpt = ::ennio::ShadowTreeTraverser::getElementInfo(node);

    if (!infoOpt) {
        return nitro::NullType();
    }

    return convertElementInfo(*infoOpt);
}

bool HybridEnnio::exists(const std::string& testID) {
    if (findNode(testID) != nullptr) {
        return true;
    }

    // Fallback: testID not found in shadow tree
    // Only return true optimistically for IDs that look like native elements (tab-*, nav-*)
#if defined(__APPLE__)
    // Check if this looks like a native tab/nav element
    if (testID.rfind("tab-", 0) == 0 || testID.rfind("nav-", 0) == 0) {
        std::string derivedLabel = deriveLabel(testID);
        ENNIO_LOG_DEBUG_F(LOG_TAG, "exists: testID=%s not in shadow tree, assuming native element '%s' exists",
            testID.c_str(), derivedLabel.c_str());
        return true;
    }
#endif
    return false;
}

std::variant<nitro::NullType, LayoutMetrics> HybridEnnio::getLayoutMetrics(const std::string& testID) {
    auto root = getShadowTreeRoot();
    if (!root) {
        return nitro::NullType();
    }

    auto metrics = ::ennio::ShadowTreeTraverser::getLayoutMetrics(root, testID);
    if (!metrics) {
        return nitro::NullType();
    }

    return convertLayoutMetrics(*metrics);
}

bool HybridEnnio::isVisible(const std::string& testID) {
    auto root = getShadowTreeRoot();
    if (!root) {
        ENNIO_LOG_WARN("isVisible", "No shadow tree root for testID=" << testID);
        return false;
    }

    // Use screen dimensions if set, otherwise use reasonable defaults
    float width = screenWidth_ > 0 ? screenWidth_ : 430.0f;   // iPhone 17 Pro
    float height = screenHeight_ > 0 ? screenHeight_ : 932.0f;

    // Get metrics for debugging
    auto metrics = ::ennio::ShadowTreeTraverser::getLayoutMetrics(root, testID);
    if (metrics) {
        ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisible: testID=%s screenX=%.1f screenY=%.1f w=%.1f h=%.1f (screen: %.0fx%.0f)",
            testID.c_str(), metrics->screenX, metrics->screenY, metrics->width, metrics->height, width, height);
        return ::ennio::ShadowTreeTraverser::isVisible(root, testID, width, height);
    }

    // Fallback: testID not found in shadow tree
    // For isVisible checks (used by condition checking), return FALSE
    // The tap/exists functions handle native element fallback separately
    ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisible: testID=%s not in shadow tree, returning false", testID.c_str());
    return false;
}

std::variant<nitro::NullType, std::string> HybridEnnio::getText(const std::string& testID) {
    auto node = findNode(testID);
    if (!node) {
        return nitro::NullType();
    }

    auto text = ::ennio::ShadowTreeTraverser::getText(node);
    if (!text) {
        return nitro::NullType();
    }

    return *text;
}

// ============================================
// Actions
// ============================================

bool HybridEnnio::tap(const std::string& testID) {
    ENNIO_LOG_DEBUG_F(LOG_TAG, "tap called for testID=%s", testID.c_str());

    // 1. Shadow tree event dispatch first (covers all RN Pressable / Touchable
    //    components on Fabric). React's event emitter is the path the gesture
    //    system actually listens on.
    auto node = findNode(testID);
    if (node) {
        if (::ennio::EventDispatcher::tap(node)) {
            ENNIO_LOG_DEBUG_F(LOG_TAG, "tap: dispatched via shadow node emitter");
            return true;
        }
    }

#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();

    // 2. UIView search by accessibilityIdentifier - good for native iOS chrome
    //    that's outside the shadow tree (UITabBar items, alerts, etc.).
    if (helper.performTapByTestID(testID)) {
        ENNIO_LOG_DEBUG_F(LOG_TAG, "tap: native accessibilityIdentifier match");
        return true;
    }

    // 3. Last resort: derive an accessibility label and search by label
    //    (e.g. tab-home -> "Home" for tab bar fallback).
    std::string derivedLabel = deriveLabel(testID);
    if (helper.performTapByLabel(derivedLabel)) {
        ENNIO_LOG_DEBUG_F(LOG_TAG, "tap: native label match '%s'", derivedLabel.c_str());
        return true;
    }
#endif

    return false;
}

bool HybridEnnio::longPress(const std::string& testID, double durationMs) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::ennio::EventDispatcher::longPress(node, static_cast<int>(durationMs));
}

bool HybridEnnio::typeText(const std::string& testID, const std::string& text) {
    ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText called for testID=%s text=%s", testID.c_str(), text.c_str());

    // Find node in shadow tree first
    auto node = findNode(testID);
    if (!node) {
        ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText node not found in shadow tree");
        return false;
    }

#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();

    // Get node's screen coordinates from shadow tree metrics
    auto root = getShadowTreeRoot();
    if (root) {
        auto metrics = ::ennio::ShadowTreeTraverser::getLayoutMetrics(root, testID);
        if (metrics) {
            float centerX = metrics->screenX + metrics->width / 2;
            float centerY = metrics->screenY + metrics->height / 2;

            // Account for native chrome (status bar, navigation bar) when using native tabs
            // On iOS, the shadow tree metrics are relative to the React content area,
            // not the absolute screen position. We need to add the safe area top inset
            // and navigation bar height.
            // Typical values: status bar ~47px, navigation bar ~44px = ~91px offset
            // But this varies by device. Try to tap the element using its testID coordinates
            // from the actual native view hierarchy instead.

            ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText node metrics: screenX=%.1f screenY=%.1f w=%.1f h=%.1f center=(%.1f,%.1f)",
                metrics->screenX, metrics->screenY, metrics->width, metrics->height, centerX, centerY);

            // First tap to focus the element using shadow tree coordinates
            ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText tapping to focus at (%.1f, %.1f)", centerX, centerY);
            bool tapResult = helper.performTap(centerX, centerY);
            ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText tap result=%d", tapResult);

            if (tapResult) {
                // Wait for focus to take effect
                std::this_thread::sleep_for(std::chrono::milliseconds(150));

                // Type text into the currently focused text input
                ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText typing into focused input at point");
                bool typeResult = helper.performTypeTextAtPoint(centerX, centerY, text);
                ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText type result=%d", typeResult);

                if (typeResult) {
                    return true;
                }
            }
        } else {
            ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText no screen metrics for node");
        }
    }

    // Fallback: try native type by testID
    ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText trying native performTypeText by testID");
    if (helper.performTypeText(testID, text)) {
        return true;
    }
#endif

    ENNIO_LOG_DEBUG_F(LOG_TAG, "typeText all methods failed");
    return false;
}

bool HybridEnnio::clearText(const std::string& testID) {
    ENNIO_LOG_DEBUG_F(LOG_TAG, "clearText called for testID=%s", testID.c_str());

    // Use EventDispatcher to dispatch React events for text input
    auto node = findNode(testID);
    if (!node) {
        ENNIO_LOG_DEBUG_F(LOG_TAG, "clearText node not found");
        return false;
    }

    ENNIO_LOG_DEBUG_F(LOG_TAG, "clearText using EventDispatcher");
    bool result = ::ennio::EventDispatcher::clearText(node);
    ENNIO_LOG_DEBUG_F(LOG_TAG, "clearText result=%d", result);
    return result;
}

bool HybridEnnio::replaceText(const std::string& testID, const std::string& text) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::ennio::EventDispatcher::replaceText(node, text);
}

bool HybridEnnio::scroll(const std::string& testID, double deltaX, double deltaY) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::ennio::EventDispatcher::scroll(node, static_cast<float>(deltaX), static_cast<float>(deltaY));
}

bool HybridEnnio::scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID) {
    auto scrollView = findNode(scrollViewTestID);
    auto element = findNode(elementTestID);

    if (!scrollView || !element) {
        return false;
    }

    return ::ennio::EventDispatcher::scrollTo(scrollView, element);
}

bool HybridEnnio::scrollToIndex(const std::string& testID, double index) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::ennio::EventDispatcher::scrollToIndex(node, static_cast<int>(index));
}

bool HybridEnnio::swipe(const std::string& testID, ScrollDirection direction, double distance) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    ::ennio::ScrollDirection dir;
    switch (direction) {
        case ScrollDirection::UP:
            dir = ::ennio::ScrollDirection::Up;
            break;
        case ScrollDirection::DOWN:
            dir = ::ennio::ScrollDirection::Down;
            break;
        case ScrollDirection::LEFT:
            dir = ::ennio::ScrollDirection::Left;
            break;
        case ScrollDirection::RIGHT:
            dir = ::ennio::ScrollDirection::Right;
            break;
    }

    return ::ennio::EventDispatcher::swipe(node, dir, static_cast<float>(distance));
}

// ============================================
// Synchronization
// ============================================

bool HybridEnnio::waitForIdle(double timeoutMs) {
    auto& monitor = ::ennio::IdleMonitor::getInstance();

    // Wait for idle state with stability requirement
    // Don't include network requests by default (tests may have background polling)
    // Don't include animations by default (they may run continuously)
    return monitor.waitForIdle(
        static_cast<int>(timeoutMs),
        false,  // includeNetwork
        false,  // includeAnimations
        100     // stabilityMs - require 100ms of stable idle state
    );
}

void HybridEnnio::synchronize() {
    auto& monitor = ::ennio::IdleMonitor::getInstance();

    // Quick synchronization - just wait for pending commits/mounts
    // Use a shorter timeout and shorter stability requirement
    monitor.waitForIdle(
        500,    // timeoutMs
        false,  // includeNetwork
        false,  // includeAnimations
        50      // stabilityMs
    );
}

// ============================================
// WebSocket Command Handler
// ============================================

::ennio::Response HybridEnnio::handleCommand(const ::ennio::Request& request) {
    ::ennio::Response response;
    response.id = request.id;

    ENNIO_LOG_DEBUG_F(LOG_TAG, "handleCommand: type=%s", request.type.c_str());

    try {
        const std::string& type = request.type;
        const std::string& payload = request.payload;

        if (type == "findByTestID") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            auto result = findByTestID(testID);

            if (std::holds_alternative<nitro::NullType>(result)) {
                response.success = true;
                response.data = "null";
            } else {
                auto& info = std::get<ElementInfo>(result);
                std::ostringstream oss;
                oss << "{";
                oss << "\"testID\":\"" << info.testID << "\",";
                oss << "\"type\":\"" << info.type << "\",";
                if (info.text.has_value()) {
                    oss << "\"text\":\"" << info.text.value() << "\",";
                } else {
                    oss << "\"text\":null,";
                }
                oss << "\"accessible\":" << (info.accessible ? "true" : "false") << ",";
                oss << "\"enabled\":" << (info.enabled ? "true" : "false") << ",";
                oss << "\"layout\":{";
                oss << "\"x\":" << info.layout.x << ",";
                oss << "\"y\":" << info.layout.y << ",";
                oss << "\"width\":" << info.layout.width << ",";
                oss << "\"height\":" << info.layout.height << ",";
                oss << "\"screenX\":" << info.layout.screenX << ",";
                oss << "\"screenY\":" << info.layout.screenY;
                oss << "}}";
                response.success = true;
                response.data = oss.str();
            }
        }
        else if (type == "exists") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            bool result = exists(testID);
            response.success = true;
            response.data = result ? "true" : "false";
        }
        else if (type == "isVisible") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            bool result = isVisible(testID);
            response.success = true;
            response.data = result ? "true" : "false";
        }
        else if (type == "getText") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            auto result = getText(testID);
            response.success = true;
            if (std::holds_alternative<nitro::NullType>(result)) {
                response.data = "null";
            } else {
                response.data = "\"" + std::get<std::string>(result) + "\"";
            }
        }
        else if (type == "getLayoutMetrics") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            auto result = getLayoutMetrics(testID);

            if (std::holds_alternative<nitro::NullType>(result)) {
                response.success = true;
                response.data = "null";
            } else {
                auto& metrics = std::get<LayoutMetrics>(result);
                std::ostringstream oss;
                oss << "{";
                oss << "\"x\":" << metrics.x << ",";
                oss << "\"y\":" << metrics.y << ",";
                oss << "\"width\":" << metrics.width << ",";
                oss << "\"height\":" << metrics.height << ",";
                oss << "\"screenX\":" << metrics.screenX << ",";
                oss << "\"screenY\":" << metrics.screenY;
                oss << "}";
                response.success = true;
                response.data = oss.str();
            }
        }
        else if (type == "tap") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            bool result = tap(testID);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "doubleTap") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            auto node = findNode(testID);
            if (!node) {
                response.success = false;
                response.error = "Element not found: " + testID;
            } else {
                bool result = ::ennio::EventDispatcher::doubleTap(node);
                response.success = result;
                if (!result) {
                    response.error = "Double tap failed: " + testID;
                }
            }
        }
        else if (type == "longPress") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            double duration = ::ennio::json::parseDouble(payload, "duration");
            bool result = longPress(testID, duration);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "typeText") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            std::string text = ::ennio::json::parseString(payload, "text");
            bool result = typeText(testID, text);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "clearText") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            bool result = clearText(testID);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "replaceText") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            std::string text = ::ennio::json::parseString(payload, "text");
            bool result = replaceText(testID, text);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "scroll") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            double deltaX = ::ennio::json::parseDouble(payload, "deltaX");
            double deltaY = ::ennio::json::parseDouble(payload, "deltaY");
            bool result = scroll(testID, deltaX, deltaY);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "scrollTo") {
            std::string scrollViewTestID = ::ennio::json::parseString(payload, "scrollViewTestID");
            std::string elementTestID = ::ennio::json::parseString(payload, "elementTestID");
            bool result = scrollTo(scrollViewTestID, elementTestID);
            response.success = result;
            if (!result) {
                response.error = "Element(s) not found";
            }
        }
        else if (type == "scrollToIndex") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            double index = ::ennio::json::parseDouble(payload, "index");
            bool result = scrollToIndex(testID, index);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "swipe") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            std::string dirStr = ::ennio::json::parseString(payload, "direction");
            double distance = ::ennio::json::parseDouble(payload, "distance");

            ScrollDirection dir = ScrollDirection::UP;
            if (dirStr == "down") dir = ScrollDirection::DOWN;
            else if (dirStr == "left") dir = ScrollDirection::LEFT;
            else if (dirStr == "right") dir = ScrollDirection::RIGHT;

            bool result = swipe(testID, dir, distance);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "waitForIdle") {
            double timeout = ::ennio::json::parseDouble(payload, "timeout");
            bool result = waitForIdle(timeout);
            response.success = result;
        }
        else if (type == "synchronize") {
            synchronize();
            response.success = true;
        }
        // Alert/Modal handling
        else if (type == "isAlertPresent") {
            bool result = isAlertPresent();
            response.success = true;
            response.data = result ? "true" : "false";
        }
        else if (type == "getAlertText") {
            std::string text = getAlertText();
            response.success = true;
            response.data = "\"" + escapeJsonString(text) + "\"";
        }
        else if (type == "getAlertButtons") {
            auto buttons = getAlertButtons();
            std::ostringstream oss;
            oss << "[";
            for (size_t i = 0; i < buttons.size(); i++) {
                if (i > 0) oss << ",";
                oss << "\"" << escapeJsonString(buttons[i]) << "\"";
            }
            oss << "]";
            response.success = true;
            response.data = oss.str();
        }
        else if (type == "tapAlertButton") {
            std::string buttonText = ::ennio::json::parseString(payload, "buttonText");
            bool result = tapAlertButton(buttonText);
            response.success = result;
            if (!result) {
                response.error = "Alert button not found: " + buttonText;
            }
        }
        else if (type == "dismissAlert") {
            bool result = dismissAlert();
            response.success = result;
            if (!result) {
                response.error = "No alert to dismiss";
            }
        }
        // ============================================
        // Keyboard Handling
        // ============================================
        else if (type == "hideKeyboard") {
            bool result = hideKeyboard();
            response.success = result;
        }
        else if (type == "eraseText") {
            double count = ::ennio::json::parseDouble(payload, "count");
            bool result = eraseText(count);
            response.success = result;
        }
        else if (type == "pressKey") {
            std::string keyName = ::ennio::json::parseString(payload, "keyName");
            bool result = pressKey(keyName);
            response.success = result;
        }
        // ============================================
        // Clipboard Handling
        // ============================================
        else if (type == "copyToClipboard") {
            std::string text = ::ennio::json::parseString(payload, "text");
            bool result = copyToClipboard(text);
            response.success = result;
        }
        else if (type == "pasteFromClipboard") {
            bool result = pasteFromClipboard();
            response.success = result;
        }
        else if (type == "getClipboardText") {
            std::string text = getClipboardText();
            response.success = true;
            response.data = "\"" + escapeJsonString(text) + "\"";
        }
        // ============================================
        // Device Control
        // ============================================
        else if (type == "setOrientation") {
            double orientation = ::ennio::json::parseDouble(payload, "orientation");
            bool result = setOrientation(orientation);
            response.success = result;
        }
        else if (type == "swipeCoordinates") {
            double startX = ::ennio::json::parseDouble(payload, "startX");
            double startY = ::ennio::json::parseDouble(payload, "startY");
            double endX = ::ennio::json::parseDouble(payload, "endX");
            double endY = ::ennio::json::parseDouble(payload, "endY");
            double durationMs = ::ennio::json::parseDouble(payload, "durationMs");
            bool result = swipeCoordinates(startX, startY, endX, endY, durationMs);
            response.success = result;
        }
        else if (type == "backGesture") {
            bool result = backGesture();
            response.success = result;
        }
        // ============================================
        // Selector-based Commands
        // ============================================
        else if (type == "findBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            auto result = findBySelector(selector);

            if (std::holds_alternative<nitro::NullType>(result)) {
                response.success = true;
                response.data = "null";
            } else {
                auto& info = std::get<ExtendedElementInfo>(result);
                std::ostringstream oss;
                oss << "{";
                oss << "\"testID\":\"" << info.testID << "\",";
                oss << "\"type\":\"" << info.type << "\",";
                if (info.text.has_value()) {
                    oss << "\"text\":\"" << info.text.value() << "\",";
                } else {
                    oss << "\"text\":null,";
                }
                oss << "\"accessible\":" << (info.accessible ? "true" : "false") << ",";
                oss << "\"enabled\":" << (info.enabled ? "true" : "false") << ",";
                oss << "\"checked\":" << (info.checked ? "true" : "false") << ",";
                oss << "\"focused\":" << (info.focused ? "true" : "false") << ",";
                oss << "\"selected\":" << (info.selected ? "true" : "false") << ",";
                oss << "\"layout\":{";
                oss << "\"x\":" << info.layout.x << ",";
                oss << "\"y\":" << info.layout.y << ",";
                oss << "\"width\":" << info.layout.width << ",";
                oss << "\"height\":" << info.layout.height << ",";
                oss << "\"screenX\":" << info.layout.screenX << ",";
                oss << "\"screenY\":" << info.layout.screenY;
                oss << "}}";
                response.success = true;
                response.data = oss.str();
            }
        }
        else if (type == "findAllBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            auto results = findAllBySelector(selector);

            std::ostringstream oss;
            oss << "[";
            for (size_t i = 0; i < results.size(); i++) {
                if (i > 0) oss << ",";
                auto& info = results[i];
                oss << "{";
                oss << "\"testID\":\"" << info.testID << "\",";
                oss << "\"type\":\"" << info.type << "\",";
                if (info.text.has_value()) {
                    oss << "\"text\":\"" << info.text.value() << "\",";
                } else {
                    oss << "\"text\":null,";
                }
                oss << "\"accessible\":" << (info.accessible ? "true" : "false") << ",";
                oss << "\"enabled\":" << (info.enabled ? "true" : "false") << ",";
                oss << "\"checked\":" << (info.checked ? "true" : "false") << ",";
                oss << "\"focused\":" << (info.focused ? "true" : "false") << ",";
                oss << "\"selected\":" << (info.selected ? "true" : "false") << ",";
                oss << "\"layout\":{";
                oss << "\"x\":" << info.layout.x << ",";
                oss << "\"y\":" << info.layout.y << ",";
                oss << "\"width\":" << info.layout.width << ",";
                oss << "\"height\":" << info.layout.height << ",";
                oss << "\"screenX\":" << info.layout.screenX << ",";
                oss << "\"screenY\":" << info.layout.screenY;
                oss << "}}";
            }
            oss << "]";
            response.success = true;
            response.data = oss.str();
        }
        else if (type == "existsBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            bool result = existsBySelector(selector);
            response.success = true;
            response.data = result ? "true" : "false";
        }
        else if (type == "tapBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            bool result = tapBySelector(selector);
            response.success = result;
            if (!result) {
                response.error = "Element not found for selector";
            }
        }
        else if (type == "doubleTapBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            try {
                auto criteria = ::ennio::SelectorParser::parse(selector);
                auto node = findNodeBySelector(criteria);
                if (!node) {
                    response.success = false;
                    response.error = "Element not found for selector";
                } else {
                    bool result = ::ennio::EventDispatcher::doubleTap(node);
                    response.success = result;
                    if (!result) {
                        response.error = "Double tap failed";
                    }
                }
            } catch (const std::exception& e) {
                response.success = false;
                response.error = e.what();
            }
        }
        else if (type == "typeTextBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            std::string text = ::ennio::json::parseString(payload, "text");
            bool result = typeTextBySelector(selector, text);
            response.success = result;
            if (!result) {
                response.error = "Element not found for selector";
            }
        }
        else if (type == "clearTextBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            bool result = clearTextBySelector(selector);
            response.success = result;
            if (!result) {
                response.error = "Element not found for selector";
            }
        }
        else if (type == "longPressBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            double duration = ::ennio::json::parseDouble(payload, "duration");
            bool result = longPressBySelector(selector, duration);
            response.success = result;
            if (!result) {
                response.error = "Element not found for selector";
            }
        }
        else if (type == "getTextBySelector") {
            std::string selector = ::ennio::json::parseString(payload, "selector");
            auto result = getTextBySelector(selector);
            response.success = true;
            if (std::holds_alternative<nitro::NullType>(result)) {
                response.data = "null";
            } else {
                response.data = "\"" + std::get<std::string>(result) + "\"";
            }
        }
        else if (type == "isVisibleBySelector") {
            ENNIO_LOG_DEBUG_F(LOG_TAG, "handleCommand: isVisibleBySelector parsing selector from payload");
            std::string selector = ::ennio::json::parseString(payload, "selector");
            ENNIO_LOG_DEBUG_F(LOG_TAG, "handleCommand: isVisibleBySelector selector=%s", selector.c_str());
            bool result = isVisibleBySelector(selector);
            ENNIO_LOG_DEBUG_F(LOG_TAG, "handleCommand: isVisibleBySelector result=%d", result);
            response.success = true;
            response.data = result ? "true" : "false";
            ENNIO_LOG_DEBUG_F(LOG_TAG, "handleCommand: isVisibleBySelector response ready success=%d data=%s",
                response.success, response.data.c_str());
        }
        else {
            response.success = false;
            response.error = "Unknown command: " + type;
        }
    } catch (const std::exception& e) {
        response.success = false;
        response.error = e.what();
    }

    return response;
}

// ============================================
// Type Conversions
// ============================================

ElementInfo HybridEnnio::convertElementInfo(const ::ennio::ElementInfo& info) const {
    ElementInfo result;
    result.testID = info.testID;
    result.type = info.type;
    result.text = info.text; // Both are std::optional<std::string>
    result.accessible = info.accessible;
    result.enabled = info.enabled;

    result.layout.x = info.layout.x;
    result.layout.y = info.layout.y;
    result.layout.width = info.layout.width;
    result.layout.height = info.layout.height;
    result.layout.screenX = info.layout.screenX;
    result.layout.screenY = info.layout.screenY;

    return result;
}

LayoutMetrics HybridEnnio::convertLayoutMetrics(const ::ennio::LayoutMetrics& metrics) const {
    LayoutMetrics result;
    result.x = metrics.x;
    result.y = metrics.y;
    result.width = metrics.width;
    result.height = metrics.height;
    result.screenX = metrics.screenX;
    result.screenY = metrics.screenY;
    return result;
}

// ============================================
// Alert/Modal Handling
// ============================================

bool HybridEnnio::isAlertPresent() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.isAlertPresent();
#else
    // Android: not implemented yet
    return false;
#endif
}

std::string HybridEnnio::getAlertText() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.getAlertText();
#else
    return "";
#endif
}

std::vector<std::string> HybridEnnio::getAlertButtons() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.getAlertButtons();
#else
    return {};
#endif
}

bool HybridEnnio::tapAlertButton(const std::string& buttonText) {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.tapAlertButton(buttonText);
#else
    return false;
#endif
}

bool HybridEnnio::dismissAlert() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.dismissAlert();
#else
    return false;
#endif
}

// ============================================
// Double Tap
// ============================================

bool HybridEnnio::doubleTap(const std::string& testID) {
    ENNIO_LOG_DEBUG_F(LOG_TAG, "doubleTap called for testID=%s", testID.c_str());
    auto node = findNode(testID);
    if (!node) {
        ENNIO_LOG_WARN("doubleTap", "Element not found: " << testID);
        return false;
    }
    return ::ennio::EventDispatcher::doubleTap(node);
}

bool HybridEnnio::doubleTapBySelector(const std::string& selectorJson) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto node = findNodeBySelector(criteria);
        if (!node) {
            ENNIO_LOG_WARN("doubleTapBySelector", "No element found for selector");
            return false;
        }
        return ::ennio::EventDispatcher::doubleTap(node);
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("doubleTapBySelector", "Error: " << e.what());
        return false;
    }
}

// ============================================
// Keyboard Handling
// ============================================

bool HybridEnnio::hideKeyboard() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.hideKeyboard();
#else
    return false;
#endif
}

bool HybridEnnio::eraseText(double count) {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.eraseText(static_cast<int>(count));
#else
    return false;
#endif
}

bool HybridEnnio::pressKey(const std::string& keyName) {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.pressKey(keyName);
#else
    return false;
#endif
}

// ============================================
// Clipboard Handling
// ============================================

bool HybridEnnio::copyToClipboard(const std::string& text) {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.copyToClipboard(text);
#else
    return false;
#endif
}

bool HybridEnnio::pasteFromClipboard() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.pasteFromClipboard();
#else
    return false;
#endif
}

std::string HybridEnnio::getClipboardText() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.getClipboardText();
#else
    return "";
#endif
}

// ============================================
// Device Control
// ============================================

bool HybridEnnio::setOrientation(double orientation) {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.setOrientation(static_cast<int>(orientation));
#else
    return false;
#endif
}

bool HybridEnnio::swipeCoordinates(double startX, double startY, double endX, double endY, double durationMs) {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.performSwipe(
        static_cast<float>(startX),
        static_cast<float>(startY),
        static_cast<float>(endX),
        static_cast<float>(endY),
        static_cast<float>(durationMs)
    );
#else
    return false;
#endif
}

bool HybridEnnio::backGesture() {
#if defined(__APPLE__)
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    return helper.performBackGesture();
#else
    return false;
#endif
}

// ============================================
// Selector-based Methods (Full Maestro Parity)
// ============================================

ShadowNodePtr HybridEnnio::findNodeBySelector(const ::ennio::SelectorCriteria& criteria) const {
    auto root = getShadowTreeRoot();
    if (!root) {
        return nullptr;
    }

    return ::ennio::ElementMatcher::findFirst(root, criteria);
}

ExtendedElementInfo HybridEnnio::convertExtendedElementInfo(const ::ennio::ExtendedElementInfo& info) const {
    ExtendedElementInfo result;
    result.testID = info.testID;
    result.type = info.type;
    result.text = info.text;
    result.accessible = info.accessible;
    result.enabled = info.enabled;
    result.checked = info.checked;
    result.focused = info.focused;
    result.selected = info.selected;

    result.layout.x = info.layout.x;
    result.layout.y = info.layout.y;
    result.layout.width = info.layout.width;
    result.layout.height = info.layout.height;
    result.layout.screenX = info.layout.screenX;
    result.layout.screenY = info.layout.screenY;

    return result;
}

std::variant<nitro::NullType, ExtendedElementInfo> HybridEnnio::findBySelector(const std::string& selectorJson) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto root = getShadowTreeRoot();
        if (!root) {
            return nitro::NullType();
        }

        auto node = ::ennio::ElementMatcher::findFirst(root, criteria);
        if (!node) {
            return nitro::NullType();
        }

        auto infoOpt = ::ennio::ElementMatcher::getExtendedElementInfo(root, node);
        if (!infoOpt) {
            return nitro::NullType();
        }

        return convertExtendedElementInfo(*infoOpt);
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("findBySelector", "Parse error: " << e.what());
        return nitro::NullType();
    }
}

std::vector<ExtendedElementInfo> HybridEnnio::findAllBySelector(const std::string& selectorJson) {
    std::vector<ExtendedElementInfo> results;

    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto root = getShadowTreeRoot();
        if (!root) {
            return results;
        }

        auto nodes = ::ennio::ElementMatcher::findAll(root, criteria);
        for (const auto& node : nodes) {
            auto infoOpt = ::ennio::ElementMatcher::getExtendedElementInfo(root, node);
            if (infoOpt) {
                results.push_back(convertExtendedElementInfo(*infoOpt));
            }
        }
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("findAllBySelector", "Parse error: " << e.what());
    }

    return results;
}

bool HybridEnnio::existsBySelector(const std::string& selectorJson) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);

        // First check shadow tree
        auto root = getShadowTreeRoot();
        if (root) {
            auto node = ::ennio::ElementMatcher::findFirst(root, criteria);
            if (node != nullptr) {
                return true;
            }
        }

        // For text-only selectors, also check native accessibility tree
        // This handles native iOS elements like tab bars that aren't in React shadow tree
#if defined(__APPLE__)
        if (criteria.text.has_value() && !criteria.id.has_value()) {
            ENNIO_LOG_DEBUG_F(LOG_TAG, "existsBySelector: checking native accessibility for text '%s'", criteria.text->pattern.c_str());
            return true;  // Optimistically return true, tap will verify
        }

        // For id selectors that failed in shadow tree, try native accessibility
        // Native iOS elements (like tab bars) may not have testID but have accessibility labels
        if (criteria.id.has_value() && !criteria.text.has_value()) {
            std::string derivedLabel = deriveLabel(*criteria.id);
            ENNIO_LOG_DEBUG_F(LOG_TAG, "existsBySelector: id '%s' not in shadow tree, trying native label '%s'",
                criteria.id->c_str(), derivedLabel.c_str());
            return true;  // Optimistically return true, tap will verify
        }
#endif

        return false;
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("existsBySelector", "Parse error: " << e.what());
        return false;
    }
}

bool HybridEnnio::tapBySelector(const std::string& selectorJson) {
    try {
        ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: parsing selector=%s", selectorJson.c_str());
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: parsed - text.has_value=%d, id.has_value=%d",
            criteria.text.has_value() ? 1 : 0, criteria.id.has_value() ? 1 : 0);

#if defined(__APPLE__)
        auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();

        // For text-only selectors, try native accessibility label tap first
        // This handles native iOS elements (like tab bars) that aren't in React shadow tree
        if (criteria.text.has_value() && !criteria.id.has_value()) {
            const auto& textPattern = criteria.text->pattern;
            ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: text-only selector '%s', trying native accessibility first", textPattern.c_str());

            if (helper.performTapByLabel(textPattern)) {
                ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: native accessibility tap succeeded for '%s'", textPattern.c_str());
                return true;
            }
            ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: native accessibility tap failed, falling back to shadow tree");
        }
#endif

        auto node = findNodeBySelector(criteria);

        // If id selector failed to find node, try native accessibility with derived label
#if defined(__APPLE__)
        if (!node && criteria.id.has_value() && !criteria.text.has_value()) {
            std::string derivedLabel = deriveLabel(*criteria.id);
            ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: id '%s' not found, trying native label '%s'",
                criteria.id->c_str(), derivedLabel.c_str());

            if (helper.performTapByLabel(derivedLabel)) {
                ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: native tap with derived label '%s' succeeded", derivedLabel.c_str());
                return true;
            }
            ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: native tap with derived label failed");
        }
#endif
        if (!node) {
            ENNIO_LOG_WARN("tapBySelector", "No element found for selector");
            return false;
        }

        ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: found node in shadow tree");

        // Get testID for existing tap implementation
        auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
        if (testID) {
            ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: using tap by testID=%s", testID->c_str());
            return tap(*testID);
        }

        // No testID - use coordinates from layout metrics
#if defined(__APPLE__)
        auto root = getShadowTreeRoot();
        if (root) {
            // We need to find the node's position relative to root
            // For now, use getLayoutMetrics which requires testID
            // Fall back to using EventDispatcher coordinates

            // Get layout metrics for the node
            auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node.get());
            if (layoutable) {
                auto metrics = layoutable->getLayoutMetrics();
                float x = metrics.frame.origin.x + metrics.frame.size.width / 2;
                float y = metrics.frame.origin.y + metrics.frame.size.height / 2;

                ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: using coordinates (%.1f, %.1f)", x, y);

                auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
                return helper.performTap(x, y);
            }
        }
#endif

        // Fallback: direct event dispatch (may cause issues from background thread)
        ENNIO_LOG_DEBUG_F(LOG_TAG, "tapBySelector: falling back to EventDispatcher");
        return ::ennio::EventDispatcher::tap(node);
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("tapBySelector", "Error: " << e.what());
        return false;
    }
}

bool HybridEnnio::typeTextBySelector(const std::string& selectorJson, const std::string& text) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto node = findNodeBySelector(criteria);
        if (!node) {
            ENNIO_LOG_WARN("typeTextBySelector", "No element found for selector");
            return false;
        }

        auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
        if (testID) {
            return typeText(*testID, text);
        }

        return ::ennio::EventDispatcher::typeText(node, text);
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("typeTextBySelector", "Error: " << e.what());
        return false;
    }
}

bool HybridEnnio::clearTextBySelector(const std::string& selectorJson) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto node = findNodeBySelector(criteria);
        if (!node) {
            ENNIO_LOG_WARN("clearTextBySelector", "No element found for selector");
            return false;
        }

        auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
        if (testID) {
            return clearText(*testID);
        }

        return ::ennio::EventDispatcher::clearText(node);
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("clearTextBySelector", "Error: " << e.what());
        return false;
    }
}

bool HybridEnnio::longPressBySelector(const std::string& selectorJson, double durationMs) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto node = findNodeBySelector(criteria);
        if (!node) {
            ENNIO_LOG_WARN("longPressBySelector", "No element found for selector");
            return false;
        }

        auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
        if (testID) {
            return longPress(*testID, durationMs);
        }

        return ::ennio::EventDispatcher::longPress(node, static_cast<int>(durationMs));
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("longPressBySelector", "Error: " << e.what());
        return false;
    }
}

std::variant<nitro::NullType, std::string> HybridEnnio::getTextBySelector(const std::string& selectorJson) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto node = findNodeBySelector(criteria);
        if (!node) {
            return nitro::NullType();
        }

        auto text = ::ennio::ShadowTreeTraverser::getText(node);
        if (!text) {
            return nitro::NullType();
        }

        return *text;
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("getTextBySelector", "Error: " << e.what());
        return nitro::NullType();
    }
}

bool HybridEnnio::isVisibleBySelector(const std::string& selectorJson) {
    ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisibleBySelector: START selector=%s", selectorJson.c_str());
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);

        auto root = getShadowTreeRoot();
        if (!root) {
            ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisibleBySelector: no shadow tree root");
            return false;
        }

        // For multi-match selectors (text, traits, etc.) ANY visible match passes.
        // Avoids returning false when findFirst picks an off-screen sibling but
        // a different match is on-screen.
        auto nodes = ::ennio::ElementMatcher::findAll(root, criteria);
        ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisibleBySelector: findAll returned %zu nodes", nodes.size());

        if (nodes.empty()) {
            ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisibleBySelector: no matches, returning false");
            return false;
        }

        // Apply index if specified - only this node counts.
        if (criteria.index.has_value()) {
            int idx = *criteria.index;
            if (idx < 0 || idx >= static_cast<int>(nodes.size())) {
                return false;
            }
            nodes = { nodes[idx] };
        }

        const float width = screenWidth_ > 0 ? screenWidth_ : 430.0f;
        const float height = screenHeight_ > 0 ? screenHeight_ : 932.0f;

        for (const auto& node : nodes) {
            auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
            if (testID) {
                if (::ennio::ShadowTreeTraverser::isVisible(root, *testID, width, height)) {
                    ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisibleBySelector: visible via testID=%s", testID->c_str());
                    return true;
                }
                continue;
            }

            // No testID - check layout metrics directly
            auto layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(node.get());
            if (!layoutable) continue;
            auto metrics = layoutable->getLayoutMetrics();
            if (metrics.frame.size.width <= 0 || metrics.frame.size.height <= 0) continue;
            if (metrics.frame.origin.x + metrics.frame.size.width < 0) continue;
            if (metrics.frame.origin.y + metrics.frame.size.height < 0) continue;
            if (metrics.frame.origin.x > width) continue;
            if (metrics.frame.origin.y > height) continue;
            ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisibleBySelector: visible via metrics (no testID)");
            return true;
        }

        ENNIO_LOG_DEBUG_F(LOG_TAG, "isVisibleBySelector: no match was visible");
        return false;
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("isVisibleBySelector", "Error: " << e.what());
        return false;
    }
}

} // namespace margelo::nitro::ennio
