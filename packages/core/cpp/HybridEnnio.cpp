#include "HybridEnnio.hpp"
#include "IdleMonitor.hpp"
#include "EnnioLog.hpp"
#include "SelectorParser.hpp"

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
    // prior commits). Live walk costs O(n) but matches what the user sees on
    // screen.
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

    // Fallback: testID not found in shadow tree.
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
        // ============================================
        // Fast-mode write dispatch (NitroWriter -> WS -> here)
        // ============================================
        else if (type == "tap") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            response.success = tap(testID);
        }
        else if (type == "tapByLabel") {
            std::string text = ::ennio::json::parseString(payload, "text");
            response.success = tapByLabel(text);
        }
        else if (type == "doubleTap") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            response.success = doubleTap(testID);
        }
        else if (type == "longPress") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            double duration = ::ennio::json::parseDouble(payload, "duration");
            if (duration <= 0) duration = 500;
            response.success = longPress(testID, duration);
        }
        else if (type == "typeText") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            std::string text = ::ennio::json::parseString(payload, "text");
            response.success = typeText(testID, text);
        }
        else if (type == "clearText") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            response.success = clearText(testID);
        }
        else if (type == "eraseText") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            double count = ::ennio::json::parseDouble(payload, "count");
            if (count <= 0) count = 1;
            response.success = eraseText(testID, count);
        }
        else if (type == "pressKey") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            std::string keyName = ::ennio::json::parseString(payload, "keyName");
            response.success = pressKey(testID, keyName);
        }
        else if (type == "scroll") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            std::string dir = ::ennio::json::parseString(payload, "direction");
            if (dir.empty()) dir = "down";
            double distance = ::ennio::json::parseDouble(payload, "distance");
            if (distance <= 0) distance = 200;
            ScrollDirection sd = ScrollDirection::DOWN;
            if (dir == "up") sd = ScrollDirection::UP;
            else if (dir == "down") sd = ScrollDirection::DOWN;
            else if (dir == "left") sd = ScrollDirection::LEFT;
            else if (dir == "right") sd = ScrollDirection::RIGHT;
            response.success = scroll(testID, sd, distance);
        }
        else if (type == "swipe") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            std::string dir = ::ennio::json::parseString(payload, "direction");
            if (dir.empty()) dir = "down";
            double distance = ::ennio::json::parseDouble(payload, "distance");
            if (distance <= 0) distance = 200;
            ScrollDirection sd = ScrollDirection::DOWN;
            if (dir == "up") sd = ScrollDirection::UP;
            else if (dir == "down") sd = ScrollDirection::DOWN;
            else if (dir == "left") sd = ScrollDirection::LEFT;
            else if (dir == "right") sd = ScrollDirection::RIGHT;
            response.success = swipe(testID, sd, distance);
        }
        else if (type == "scrollTo") {
            std::string sv = ::ennio::json::parseString(payload, "scrollViewTestID");
            std::string el = ::ennio::json::parseString(payload, "elementTestID");
            response.success = scrollTo(sv, el);
        }
        else if (type == "tapTab") {
            double idx = ::ennio::json::parseDouble(payload, "index");
            response.success = tapTab(idx);
        }
        else if (type == "backGesture") {
            response.success = backGesture();
        }
        else if (type == "hideKeyboard") {
            response.success = hideKeyboard();
        }
        else if (type == "tapBySelector") {
            std::string sel = ::ennio::json::parseString(payload, "selector");
            response.success = tapBySelector(sel);
        }
        else if (type == "doubleTapBySelector") {
            std::string sel = ::ennio::json::parseString(payload, "selector");
            response.success = doubleTapBySelector(sel);
        }
        else if (type == "longPressBySelector") {
            std::string sel = ::ennio::json::parseString(payload, "selector");
            double duration = ::ennio::json::parseDouble(payload, "duration");
            if (duration <= 0) duration = 500;
            response.success = longPressBySelector(sel, duration);
        }
        else if (type == "typeTextBySelector") {
            std::string sel = ::ennio::json::parseString(payload, "selector");
            std::string text = ::ennio::json::parseString(payload, "text");
            response.success = typeTextBySelector(sel, text);
        }
        else if (type == "clearTextBySelector") {
            std::string sel = ::ennio::json::parseString(payload, "selector");
            response.success = clearTextBySelector(sel);
        }
        else if (type == "tapAlertButton") {
            std::string btn = ::ennio::json::parseString(payload, "buttonText");
            response.success = tapAlertButton(btn);
        }
        else if (type == "dismissAlert") {
            response.success = dismissAlert();
        }
        else if (type == "copyToClipboard") {
            std::string text = ::ennio::json::parseString(payload, "text");
            response.success = copyToClipboard(text);
        }
        else if (type == "pasteFromClipboard") {
            std::string testID = ::ennio::json::parseString(payload, "testID");
            response.success = pasteFromClipboard(testID);
        }
        else if (type == "getClipboardText") {
            std::string text = getClipboardText();
            response.success = true;
            response.data = "\"" + text + "\"";
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

        auto root = getShadowTreeRoot();
        if (root) {
            auto node = ::ennio::ElementMatcher::findFirst(root, criteria);
            if (node != nullptr) {
                return true;
            }
        }

        return false;
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("existsBySelector", "Parse error: " << e.what());
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

// ============================================
// Fast-mode Writes
//
// Each method delegates to EnnioRuntimeHelper, which finds the UIView by
// accessibilityIdentifier and invokes the matching UIKit / accessibility
// API. Selector-based variants resolve the testID through the shadow
// tree first, then dispatch the same write.
// ============================================

#if defined(__APPLE__)

namespace {

const char* scrollDirectionToString(ScrollDirection direction) {
    switch (direction) {
        case ScrollDirection::UP: return "up";
        case ScrollDirection::DOWN: return "down";
        case ScrollDirection::LEFT: return "left";
        case ScrollDirection::RIGHT: return "right";
        default: return "down";
    }
}

} // namespace

bool HybridEnnio::tap(const std::string& testID) {
    // Walk the UIView tree by accessibilityIdentifier and run the
    // fireActivation chain on the matched view: UIControl.sendActions
    // (RNGH BaseButton), synthesised UITouch (vanilla RN Pressable),
    // accessibilityActivate (native widgets), gesture-recognizer KVC.
    return ::ennio::EnnioRuntimeHelper::getInstance().tap(testID);
}
bool HybridEnnio::tapByLabel(const std::string& text) {
    return ::ennio::EnnioRuntimeHelper::getInstance().tapByLabel(text);
}
bool HybridEnnio::doubleTap(const std::string& testID) {
    return ::ennio::EnnioRuntimeHelper::getInstance().doubleTap(testID);
}
bool HybridEnnio::longPress(const std::string& testID, double durationMs) {
    return ::ennio::EnnioRuntimeHelper::getInstance().longPress(testID, static_cast<int>(durationMs));
}
bool HybridEnnio::typeText(const std::string& testID, const std::string& text) {
    return ::ennio::EnnioRuntimeHelper::getInstance().typeText(testID, text);
}
bool HybridEnnio::clearText(const std::string& testID) {
    return ::ennio::EnnioRuntimeHelper::getInstance().clearText(testID);
}
bool HybridEnnio::eraseText(const std::string& testID, double count) {
    return ::ennio::EnnioRuntimeHelper::getInstance().eraseText(testID, static_cast<int>(count));
}
bool HybridEnnio::pressKey(const std::string& testID, const std::string& keyName) {
    return ::ennio::EnnioRuntimeHelper::getInstance().pressKey(testID, keyName);
}
bool HybridEnnio::scroll(const std::string& testID, ScrollDirection direction, double distance) {
    return ::ennio::EnnioRuntimeHelper::getInstance().scroll(testID, scrollDirectionToString(direction), distance);
}
bool HybridEnnio::swipe(const std::string& testID, ScrollDirection direction, double distance) {
    return ::ennio::EnnioRuntimeHelper::getInstance().swipe(testID, scrollDirectionToString(direction), distance);
}
bool HybridEnnio::scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID) {
    return ::ennio::EnnioRuntimeHelper::getInstance().scrollTo(scrollViewTestID, elementTestID);
}
bool HybridEnnio::tapTab(double index) {
    return ::ennio::EnnioRuntimeHelper::getInstance().tapTab(static_cast<int>(index));
}
bool HybridEnnio::backGesture() {
    return ::ennio::EnnioRuntimeHelper::getInstance().backGesture();
}
bool HybridEnnio::hideKeyboard() {
    return ::ennio::EnnioRuntimeHelper::getInstance().hideKeyboard();
}
bool HybridEnnio::tapAlertButton(const std::string& buttonText) {
    return ::ennio::EnnioRuntimeHelper::getInstance().tapAlertButton(buttonText);
}
bool HybridEnnio::dismissAlert() {
    return ::ennio::EnnioRuntimeHelper::getInstance().dismissAlert();
}
bool HybridEnnio::copyToClipboard(const std::string& text) {
    return ::ennio::EnnioRuntimeHelper::getInstance().copyToClipboard(text);
}
bool HybridEnnio::pasteFromClipboard(const std::string& testID) {
    return ::ennio::EnnioRuntimeHelper::getInstance().pasteFromClipboard(testID);
}
std::string HybridEnnio::getClipboardText() {
    return ::ennio::EnnioRuntimeHelper::getInstance().getClipboardText();
}

#else

// Non-Apple stubs so the spec can still build. Android fast mode is out
// of scope (the helper-less path needs UIAutomator + a different write
// surface).
bool HybridEnnio::tap(const std::string&) { return false; }
bool HybridEnnio::tapByLabel(const std::string&) { return false; }
bool HybridEnnio::doubleTap(const std::string&) { return false; }
bool HybridEnnio::longPress(const std::string&, double) { return false; }
bool HybridEnnio::typeText(const std::string&, const std::string&) { return false; }
bool HybridEnnio::clearText(const std::string&) { return false; }
bool HybridEnnio::eraseText(const std::string&, double) { return false; }
bool HybridEnnio::pressKey(const std::string&, const std::string&) { return false; }
bool HybridEnnio::scroll(const std::string&, ScrollDirection, double) { return false; }
bool HybridEnnio::swipe(const std::string&, ScrollDirection, double) { return false; }
bool HybridEnnio::scrollTo(const std::string&, const std::string&) { return false; }
bool HybridEnnio::tapTab(double) { return false; }
bool HybridEnnio::backGesture() { return false; }
bool HybridEnnio::hideKeyboard() { return false; }
bool HybridEnnio::tapAlertButton(const std::string&) { return false; }
bool HybridEnnio::dismissAlert() { return false; }
bool HybridEnnio::copyToClipboard(const std::string&) { return false; }
bool HybridEnnio::pasteFromClipboard(const std::string&) { return false; }
std::string HybridEnnio::getClipboardText() { return ""; }

#endif

// Selector-based writes: resolve the selector to a testID via the shadow
// tree, then dispatch through the testID-keyed write. Skips wires that
// would require a different code path (the shadow-tree finder already
// handles all the complex Maestro selector forms).

namespace {

std::optional<std::string> resolveSelectorToTestID(
    const HybridEnnio& self,
    const std::string& selectorJson
) {
    // We can't call findBySelector across const (it acquires the mutex);
    // cast away the const safely because we own the instance.
    auto& mutSelf = const_cast<HybridEnnio&>(self);
    auto found = mutSelf.findBySelector(selectorJson);
    if (std::holds_alternative<nitro::NullType>(found)) return std::nullopt;
    auto info = std::get<ExtendedElementInfo>(found);
    if (info.testID.empty()) return std::nullopt;
    return info.testID;
}

} // namespace

bool HybridEnnio::tapBySelector(const std::string& selectorJson) {
    // Resolve selector → testID via Fabric shadow tree. If matched node
    // has a testID, dispatch through tap(testID) which walks the UIView
    // tree and runs fireActivation (UIControl.sendActions for RNGH
    // BaseButton, synthesise for vanilla Pressable, accessibilityActivate
    // last). For text-only selectors with no testID, fall through to
    // tapByLabel which walks the view hierarchy by accessibility label.
    auto id = resolveSelectorToTestID(*this, selectorJson);
    if (id) return tap(*id);
    // Try text fallback if the selector carries plain text.
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        if (criteria.text) {
            return ::ennio::EnnioRuntimeHelper::getInstance().tapByLabel(criteria.text->pattern);
        }
    } catch (...) { /* swallow */ }
    return false;
}
bool HybridEnnio::doubleTapBySelector(const std::string& selectorJson) {
    auto id = resolveSelectorToTestID(*this, selectorJson);
    return id ? doubleTap(*id) : false;
}
bool HybridEnnio::longPressBySelector(const std::string& selectorJson, double durationMs) {
    auto id = resolveSelectorToTestID(*this, selectorJson);
    return id ? longPress(*id, durationMs) : false;
}
bool HybridEnnio::typeTextBySelector(const std::string& selectorJson, const std::string& text) {
    auto id = resolveSelectorToTestID(*this, selectorJson);
    return id ? typeText(*id, text) : false;
}
bool HybridEnnio::clearTextBySelector(const std::string& selectorJson) {
    auto id = resolveSelectorToTestID(*this, selectorJson);
    return id ? clearText(*id) : false;
}

} // namespace margelo::nitro::ennio
