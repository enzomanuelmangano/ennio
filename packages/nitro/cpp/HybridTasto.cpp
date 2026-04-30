#include "HybridTasto.hpp"
#include "IdleMonitor.hpp"
#include "TastoLog.hpp"

#include <thread>
#include <chrono>
#include <sstream>

#include <react/renderer/uimanager/UIManagerBinding.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/components/view/ViewProps.h>

// iOS-specific helper for accessing UIManager
#if defined(__APPLE__)
#include "../ios/TastoRuntimeHelper.h"
// Use the logging function defined in TastoRuntimeHelper
extern "C" void TastoLogMessage(const char* message);
#define TASTO_LOG_IOS(fmt, ...) do { \
    char buf[512]; \
    snprintf(buf, sizeof(buf), "[Tasto] " fmt, ##__VA_ARGS__); \
    TastoLogMessage(buf); \
} while(0)
#else
#define TASTO_LOG_IOS(fmt, ...) fprintf(stderr, "[Tasto] " fmt "\n", ##__VA_ARGS__)
#endif

// Logging tag for this module
static const char* LOG_TAG = "HybridTasto";

namespace margelo::nitro::tasto {

// Must call HybridObject(TAG) directly because it's a virtual base class
HybridTasto::HybridTasto() : HybridObject(TAG) {}

// ============================================
// Initialization
// ============================================

void HybridTasto::initialize(
    std::weak_ptr<facebook::react::UIManager> uiManager,
    facebook::react::SurfaceId surfaceId
) {
    std::lock_guard<std::mutex> lock(mutex_);
    uiManager_ = uiManager;
    surfaceId_ = surfaceId;
}

bool HybridTasto::isInitialized() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return !uiManager_.expired() && surfaceId_ != 0;
}

ShadowNodePtr HybridTasto::getShadowTreeRoot() const {
#if defined(__APPLE__)
    // On iOS, try to get the UIManager through TastoRuntimeHelper first
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();

    // Always log via NSLog for debugging
    fprintf(stderr, "[Tasto] getShadowTreeRoot: TastoRuntimeHelper initialized=%s\n",
            helper.isInitialized() ? "YES" : "NO");

    if (helper.isInitialized()) {
        auto uiManager = helper.getUIManager();
        fprintf(stderr, "[Tasto] getShadowTreeRoot: UIManager=%s\n",
                uiManager ? "available" : "null");

        if (uiManager) {
            auto& shadowTreeRegistry = uiManager->getShadowTreeRegistry();
            ShadowNodePtr rootNode = nullptr;
            int surfaceCount = 0;

            shadowTreeRegistry.enumerate([&](const facebook::react::ShadowTree& shadowTree, bool& stop) {
                surfaceCount++;
                rootNode = shadowTree.getCurrentRevision().rootShadowNode;
                fprintf(stderr, "[Tasto] getShadowTreeRoot: Found surface %d with root=%s\n",
                        surfaceCount, rootNode ? "YES" : "NO");
                stop = true;
            });

            fprintf(stderr, "[Tasto] getShadowTreeRoot: Total surfaces=%d\n", surfaceCount);

            if (rootNode) {
                return rootNode;
            }
        }
    } else {
        fprintf(stderr, "[Tasto] getShadowTreeRoot: TastoRuntimeHelper NOT initialized\n");
    }
#endif

    // Fallback to stored UIManager reference
    auto uiManager = uiManager_.lock();
    if (!uiManager) {
        TASTO_LOG_WARN(LOG_TAG, "UIManager not available - is TastoRuntimeHelper initialized?");
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

ShadowNodePtr HybridTasto::findNode(const std::string& testID) const {
    TASTO_LOG_IOS("HybridTasto::findNode called for testID=%s", testID.c_str());

    // First try O(1) registry lookup
    auto& registry = ::tasto::TestIDRegistry::getInstance();
    auto node = registry.findByTestID(testID);

    if (node) {
        TASTO_LOG_IOS("HybridTasto::findNode: Found in registry");
        return node;
    }

    TASTO_LOG_IOS("HybridTasto::findNode: Not in registry, trying tree traversal");

    // Fallback to tree traversal
    auto root = getShadowTreeRoot();
    if (!root) {
        TASTO_LOG_IOS("HybridTasto::findNode: No shadow tree root!");
        return nullptr;
    }

    TASTO_LOG_IOS("HybridTasto::findNode: Got shadow tree root, updating registry");

    // Update registry while we're at it
    registry.updateFromTree(root);

    auto found = ::tasto::ShadowTreeTraverser::findByTestID(root, testID);
    TASTO_LOG_IOS("HybridTasto::findNode: Tree traversal result: %s", found ? "found" : "not found");

    return found;
}

// ============================================
// Server Management
// ============================================

void HybridTasto::startServer(double port) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (serverRunning_) {
        TASTO_LOG_WARN(LOG_TAG, "Server already running");
        return;
    }

    serverPort_ = static_cast<int>(port);
    TASTO_LOG_INFO(LOG_TAG, TASTO_LOG_FMT("Starting WebSocket server on port " << serverPort_));

    // Create and start WebSocket server
    webSocketServer_ = std::make_unique<::tasto::WebSocketServer>();
    webSocketServer_->setCommandHandler([this](const ::tasto::Request& request) {
        return handleCommand(request);
    });

    if (webSocketServer_->start(serverPort_)) {
        serverRunning_ = true;
        TASTO_LOG_INFO(LOG_TAG, "WebSocket server started successfully");
    } else {
        TASTO_LOG_ERROR(LOG_TAG, "Failed to start WebSocket server");
        webSocketServer_.reset();
    }
}

void HybridTasto::stopServer() {
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

bool HybridTasto::isServerRunning() {
    std::lock_guard<std::mutex> lock(mutex_);
    return serverRunning_;
}

// ============================================
// Element Queries
// ============================================

std::variant<nitro::NullType, ElementInfo> HybridTasto::findByTestID(const std::string& testID) {
    auto node = findNode(testID);
    if (!node) {
        return nitro::NullType();
    }

    auto root = getShadowTreeRoot();
    auto infoOpt = ::tasto::ShadowTreeTraverser::getElementInfo(node);

    if (!infoOpt) {
        return nitro::NullType();
    }

    return convertElementInfo(*infoOpt);
}

bool HybridTasto::exists(const std::string& testID) {
    return findNode(testID) != nullptr;
}

std::variant<nitro::NullType, LayoutMetrics> HybridTasto::getLayoutMetrics(const std::string& testID) {
    auto root = getShadowTreeRoot();
    if (!root) {
        return nitro::NullType();
    }

    auto metrics = ::tasto::ShadowTreeTraverser::getLayoutMetrics(root, testID);
    if (!metrics) {
        return nitro::NullType();
    }

    return convertLayoutMetrics(*metrics);
}

bool HybridTasto::isVisible(const std::string& testID) {
    auto root = getShadowTreeRoot();
    if (!root) {
        TASTO_LOG_WARN("isVisible", "No shadow tree root for testID=" << testID);
        return false;
    }

    // Use screen dimensions if set, otherwise use reasonable defaults
    float width = screenWidth_ > 0 ? screenWidth_ : 430.0f;   // iPhone 17 Pro
    float height = screenHeight_ > 0 ? screenHeight_ : 932.0f;

    // Get metrics for debugging
    auto metrics = ::tasto::ShadowTreeTraverser::getLayoutMetrics(root, testID);
    if (metrics) {
        TASTO_LOG_IOS("isVisible: testID=%s screenX=%.1f screenY=%.1f w=%.1f h=%.1f (screen: %.0fx%.0f)",
            testID.c_str(), metrics->screenX, metrics->screenY, metrics->width, metrics->height, width, height);
    } else {
        TASTO_LOG_IOS("isVisible: testID=%s - no metrics", testID.c_str());
    }

    return ::tasto::ShadowTreeTraverser::isVisible(root, testID, width, height);
}

std::variant<nitro::NullType, std::string> HybridTasto::getText(const std::string& testID) {
    auto node = findNode(testID);
    if (!node) {
        return nitro::NullType();
    }

    auto text = ::tasto::ShadowTreeTraverser::getText(node);
    if (!text) {
        return nitro::NullType();
    }

    return *text;
}

// ============================================
// Actions
// ============================================

bool HybridTasto::tap(const std::string& testID) {
    TASTO_LOG_IOS("HybridTasto::tap called for testID=%s", testID.c_str());

    // First, find the node in shadow tree (works on all platforms)
    auto node = findNode(testID);
    if (!node) {
        TASTO_LOG_IOS("HybridTasto::tap: Element not found in shadow tree: %s", testID.c_str());

#if defined(__APPLE__)
        // On iOS, try to find by accessibilityIdentifier as fallback
        TASTO_LOG_IOS("HybridTasto::tap: Trying UIView search as fallback");
        auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
        return helper.performTapByTestID(testID);
#else
        return false;
#endif
    }

    TASTO_LOG_IOS("HybridTasto::tap: Found node, dispatching events");

    // Try dispatching events through the event emitter (cross-platform approach)
    // This directly triggers onPress in Pressable components
    bool eventResult = ::tasto::EventDispatcher::tap(node);
    TASTO_LOG_IOS("HybridTasto::tap: EventDispatcher result=%d", eventResult);

    if (eventResult) {
        return true;
    }

#if defined(__APPLE__)
    // If event dispatch didn't work, try native tap on iOS
    auto root = getShadowTreeRoot();
    if (root) {
        auto metrics = ::tasto::ShadowTreeTraverser::getLayoutMetrics(root, testID);
        if (metrics) {
            float centerX = metrics->screenX + (metrics->width / 2.0f);
            float centerY = metrics->screenY + (metrics->height / 2.0f);
            TASTO_LOG_IOS("HybridTasto::tap: Trying native tap at (%.1f, %.1f)", centerX, centerY);

            auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
            bool nativeResult = helper.performTap(centerX, centerY);
            TASTO_LOG_IOS("HybridTasto::tap: native tap result=%d", nativeResult);
            return nativeResult;
        }
    }
#endif

    return eventResult;
}

bool HybridTasto::longPress(const std::string& testID, double durationMs) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::tasto::EventDispatcher::longPress(node, static_cast<int>(durationMs));
}

bool HybridTasto::typeText(const std::string& testID, const std::string& text) {
    TASTO_LOG_IOS("HybridTasto::typeText called for testID=%s text=%s", testID.c_str(), text.c_str());

#if defined(__APPLE__)
    // On iOS, use native text input to avoid threading issues with event dispatch
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
    bool result = helper.performTypeText(testID, text);
    TASTO_LOG_IOS("HybridTasto::typeText result=%d", result);
    return result;
#else
    // On Android, use EventDispatcher through shadow tree
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::tasto::EventDispatcher::typeText(node, text);
#endif
}

bool HybridTasto::clearText(const std::string& testID) {
    TASTO_LOG_IOS("HybridTasto::clearText called for testID=%s", testID.c_str());

#if defined(__APPLE__)
    // On iOS, use native text input to avoid threading issues
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
    bool result = helper.performClearText(testID);
    TASTO_LOG_IOS("HybridTasto::clearText result=%d", result);
    return result;
#else
    // On Android, use EventDispatcher
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::tasto::EventDispatcher::clearText(node);
#endif
}

bool HybridTasto::replaceText(const std::string& testID, const std::string& text) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::tasto::EventDispatcher::replaceText(node, text);
}

bool HybridTasto::scroll(const std::string& testID, double deltaX, double deltaY) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::tasto::EventDispatcher::scroll(node, static_cast<float>(deltaX), static_cast<float>(deltaY));
}

bool HybridTasto::scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID) {
    auto scrollView = findNode(scrollViewTestID);
    auto element = findNode(elementTestID);

    if (!scrollView || !element) {
        return false;
    }

    return ::tasto::EventDispatcher::scrollTo(scrollView, element);
}

bool HybridTasto::scrollToIndex(const std::string& testID, double index) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    return ::tasto::EventDispatcher::scrollToIndex(node, static_cast<int>(index));
}

bool HybridTasto::swipe(const std::string& testID, ScrollDirection direction, double distance) {
    auto node = findNode(testID);
    if (!node) {
        return false;
    }

    ::tasto::ScrollDirection dir;
    switch (direction) {
        case ScrollDirection::UP:
            dir = ::tasto::ScrollDirection::Up;
            break;
        case ScrollDirection::DOWN:
            dir = ::tasto::ScrollDirection::Down;
            break;
        case ScrollDirection::LEFT:
            dir = ::tasto::ScrollDirection::Left;
            break;
        case ScrollDirection::RIGHT:
            dir = ::tasto::ScrollDirection::Right;
            break;
    }

    return ::tasto::EventDispatcher::swipe(node, dir, static_cast<float>(distance));
}

// ============================================
// Synchronization
// ============================================

bool HybridTasto::waitForIdle(double timeoutMs) {
    auto& monitor = ::tasto::IdleMonitor::getInstance();

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

void HybridTasto::synchronize() {
    auto& monitor = ::tasto::IdleMonitor::getInstance();

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

::tasto::Response HybridTasto::handleCommand(const ::tasto::Request& request) {
    ::tasto::Response response;
    response.id = request.id;

    TASTO_LOG_IOS("HybridTasto::handleCommand: type=%s", request.type.c_str());

    try {
        const std::string& type = request.type;
        const std::string& payload = request.payload;

        if (type == "findByTestID") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
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
            std::string testID = ::tasto::json::parseString(payload, "testID");
            bool result = exists(testID);
            response.success = true;
            response.data = result ? "true" : "false";
        }
        else if (type == "isVisible") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            bool result = isVisible(testID);
            response.success = true;
            response.data = result ? "true" : "false";
        }
        else if (type == "getText") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            auto result = getText(testID);
            response.success = true;
            if (std::holds_alternative<nitro::NullType>(result)) {
                response.data = "null";
            } else {
                response.data = "\"" + std::get<std::string>(result) + "\"";
            }
        }
        else if (type == "getLayoutMetrics") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
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
            std::string testID = ::tasto::json::parseString(payload, "testID");
            bool result = tap(testID);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "longPress") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            double duration = ::tasto::json::parseDouble(payload, "duration");
            bool result = longPress(testID, duration);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "typeText") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            std::string text = ::tasto::json::parseString(payload, "text");
            bool result = typeText(testID, text);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "clearText") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            bool result = clearText(testID);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "replaceText") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            std::string text = ::tasto::json::parseString(payload, "text");
            bool result = replaceText(testID, text);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "scroll") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            double deltaX = ::tasto::json::parseDouble(payload, "deltaX");
            double deltaY = ::tasto::json::parseDouble(payload, "deltaY");
            bool result = scroll(testID, deltaX, deltaY);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "scrollTo") {
            std::string scrollViewTestID = ::tasto::json::parseString(payload, "scrollViewTestID");
            std::string elementTestID = ::tasto::json::parseString(payload, "elementTestID");
            bool result = scrollTo(scrollViewTestID, elementTestID);
            response.success = result;
            if (!result) {
                response.error = "Element(s) not found";
            }
        }
        else if (type == "scrollToIndex") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            double index = ::tasto::json::parseDouble(payload, "index");
            bool result = scrollToIndex(testID, index);
            response.success = result;
            if (!result) {
                response.error = "Element not found: " + testID;
            }
        }
        else if (type == "swipe") {
            std::string testID = ::tasto::json::parseString(payload, "testID");
            std::string dirStr = ::tasto::json::parseString(payload, "direction");
            double distance = ::tasto::json::parseDouble(payload, "distance");

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
            double timeout = ::tasto::json::parseDouble(payload, "timeout");
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
            response.data = "\"" + text + "\"";
        }
        else if (type == "getAlertButtons") {
            auto buttons = getAlertButtons();
            std::ostringstream oss;
            oss << "[";
            for (size_t i = 0; i < buttons.size(); i++) {
                if (i > 0) oss << ",";
                oss << "\"" << buttons[i] << "\"";
            }
            oss << "]";
            response.success = true;
            response.data = oss.str();
        }
        else if (type == "tapAlertButton") {
            std::string buttonText = ::tasto::json::parseString(payload, "buttonText");
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

ElementInfo HybridTasto::convertElementInfo(const ::tasto::ElementInfo& info) const {
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

LayoutMetrics HybridTasto::convertLayoutMetrics(const ::tasto::LayoutMetrics& metrics) const {
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

bool HybridTasto::isAlertPresent() {
#if defined(__APPLE__)
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
    return helper.isAlertPresent();
#else
    // Android: not implemented yet
    return false;
#endif
}

std::string HybridTasto::getAlertText() {
#if defined(__APPLE__)
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
    return helper.getAlertText();
#else
    return "";
#endif
}

std::vector<std::string> HybridTasto::getAlertButtons() {
#if defined(__APPLE__)
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
    return helper.getAlertButtons();
#else
    return {};
#endif
}

bool HybridTasto::tapAlertButton(const std::string& buttonText) {
#if defined(__APPLE__)
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
    return helper.tapAlertButton(buttonText);
#else
    return false;
#endif
}

bool HybridTasto::dismissAlert() {
#if defined(__APPLE__)
    auto& helper = ::tasto::TastoRuntimeHelper::getInstance();
    return helper.dismissAlert();
#else
    return false;
#endif
}

} // namespace margelo::nitro::tasto
