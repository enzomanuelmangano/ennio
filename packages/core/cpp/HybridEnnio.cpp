#include "HybridEnnio.hpp"
#include "IdleMonitor.hpp"
#include "EnnioLog.hpp"
#include "SelectorParser.hpp"

#include <thread>
#include <chrono>
#include <sstream>
#include <atomic>
#include <condition_variable>
#include <type_traits>
#include <unordered_map>
#include <functional>

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

// SFINAE: detect ExtendedElementInfo (has `checked` / `focused` /
// `selected`). If the type doesn't, those keys are skipped — keeps
// findByTestID's plain ElementInfo response untouched while
// findBySelector / findAllBySelector emit the fuller payload.
template <typename T, typename = void>
struct hasExtendedFlags : std::false_type {};
template <typename T>
struct hasExtendedFlags<T, std::void_t<decltype(std::declval<T>().checked)>> : std::true_type {};

// Serialise an ElementInfo (or ExtendedElementInfo) to a JSON object
// literal. Centralised so findByTestID / findBySelector /
// findAllBySelector share one truth instead of three near-identical
// hand-written serialisers (the audit found drift between sites).
template <typename Info>
static std::string elementInfoToJson(const Info& info) {
    std::ostringstream oss;
    oss << "{";
    oss << "\"testID\":\"" << escapeJsonString(info.testID) << "\",";
    oss << "\"type\":\"" << escapeJsonString(info.type) << "\",";
    if (info.text.has_value()) {
        oss << "\"text\":\"" << escapeJsonString(info.text.value()) << "\",";
    } else {
        oss << "\"text\":null,";
    }
    oss << "\"accessible\":" << (info.accessible ? "true" : "false") << ",";
    oss << "\"enabled\":" << (info.enabled ? "true" : "false");
    if constexpr (hasExtendedFlags<Info>::value) {
        oss << ",\"checked\":" << (info.checked ? "true" : "false");
        oss << ",\"focused\":" << (info.focused ? "true" : "false");
        oss << ",\"selected\":" << (info.selected ? "true" : "false");
    }
    oss << ",\"layout\":{";
    oss << "\"x\":" << info.layout.x << ",";
    oss << "\"y\":" << info.layout.y << ",";
    oss << "\"width\":" << info.layout.width << ",";
    oss << "\"height\":" << info.layout.height << ",";
    oss << "\"screenX\":" << info.layout.screenX << ",";
    oss << "\"screenY\":" << info.layout.screenY;
    oss << "}}";
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
    // UIKit is authoritative when the UIView is mounted. Window-relative
    // frame respects ScrollView offset (shadow-tree screenY does not),
    // so we use it whenever the view actually has a frame. A view at
    // content-Y=2000 in a 900px-tall window correctly reports "not
    // visible" until the user scrolls to it.
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    auto frame = helper.getViewWindowFrame(testID);
    bool uiViewMounted = std::get<2>(frame) > 0 && std::get<3>(frame) > 0;
    if (uiViewMounted) {
        return helper.isViewOnscreen(testID);
    }

    // No UIView yet — try the shadow tree. Covers virtualized lists
    // (FlashList, FlatList) where the cell exists in shadow tree before
    // mounting. Layout-relative intersection still tells us if the cell
    // is in-bounds and about to be rendered.
    auto root = getShadowTreeRoot();
    if (!root) {
        ENNIO_LOG_WARN("isVisible", "No shadow tree root for testID=" << testID);
        return false;
    }
    float width = screenWidth_ > 0 ? screenWidth_ : 430.0f;
    float height = screenHeight_ > 0 ? screenHeight_ : 932.0f;
    auto metrics = ::ennio::ShadowTreeTraverser::getLayoutMetrics(root, testID);
    if (metrics) {
        return ::ennio::ShadowTreeTraverser::isVisible(root, testID, width, height);
    }
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

// Idle-detection knobs. Stability is the duration we require the system
// to stay continuously idle before returning. waitForIdle is the
// long-budget probe (assertVisible after a launch); synchronize is the
// short one between commands (just drains pending commits/mounts).
//
// Network and animations are excluded by default: tests may have
// background polling timers, and a Reanimated worklet running a spinner
// would block forever.
static constexpr int IDLE_STABILITY_MS = 100;
static constexpr int SYNCHRONIZE_TIMEOUT_MS = 500;
static constexpr int SYNCHRONIZE_STABILITY_MS = 50;

bool HybridEnnio::waitForIdle(double timeoutMs) {
    return ::ennio::IdleMonitor::getInstance().waitForIdle(
        static_cast<int>(timeoutMs),
        /* includeNetwork */ false,
        /* includeAnimations */ false,
        IDLE_STABILITY_MS
    );
}

void HybridEnnio::synchronize() {
    ::ennio::IdleMonitor::getInstance().waitForIdle(
        SYNCHRONIZE_TIMEOUT_MS,
        /* includeNetwork */ false,
        /* includeAnimations */ false,
        SYNCHRONIZE_STABILITY_MS
    );
}

// ============================================
// WebSocket Command Handler
// ============================================
//
// Replaces the legacy 445-line if-chain with a string→lambda dispatch
// table. Each handler is small (parse args → call method → fill
// response). Adding a new command is one map entry. Hot-loop cost: a
// single unordered_map lookup per request, vs the previous O(n)
// string compare cascade.

using HandlerFn = std::function<void(HybridEnnio*, const ::ennio::Request&, ::ennio::Response&)>;

static const std::unordered_map<std::string, HandlerFn>& commandHandlers() {
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance;
    static const std::unordered_map<std::string, HandlerFn> handlers = {
        // ---- Read queries ----
        { "findByTestID", [](HybridEnnio* self, const auto& req, auto& r) {
            auto result = self->findByTestID(::ennio::json::parseString(req.payload, "testID"));
            r.success = true;
            r.data = std::holds_alternative<nitro::NullType>(result)
                     ? "null"
                     : elementInfoToJson(std::get<ElementInfo>(result));
        }},
        { "exists", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = true;
            r.data = self->exists(::ennio::json::parseString(req.payload, "testID")) ? "true" : "false";
        }},
        { "isVisible", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = true;
            r.data = self->isVisible(::ennio::json::parseString(req.payload, "testID")) ? "true" : "false";
        }},
        { "getText", [](HybridEnnio* self, const auto& req, auto& r) {
            auto result = self->getText(::ennio::json::parseString(req.payload, "testID"));
            r.success = true;
            r.data = std::holds_alternative<nitro::NullType>(result)
                     ? "null"
                     : "\"" + escapeJsonString(std::get<std::string>(result)) + "\"";
        }},
        { "getLayoutMetrics", [](HybridEnnio* self, const auto& req, auto& r) {
            auto result = self->getLayoutMetrics(::ennio::json::parseString(req.payload, "testID"));
            r.success = true;
            if (std::holds_alternative<nitro::NullType>(result)) {
                r.data = "null";
                return;
            }
            auto& m = std::get<LayoutMetrics>(result);
            std::ostringstream oss;
            oss << "{\"x\":" << m.x << ",\"y\":" << m.y
                << ",\"width\":" << m.width << ",\"height\":" << m.height
                << ",\"screenX\":" << m.screenX << ",\"screenY\":" << m.screenY << "}";
            r.data = oss.str();
        }},

        // ---- Synchronization ----
        { "waitForIdle", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->waitForIdle(::ennio::json::parseDouble(req.payload, "timeout"));
        }},
        { "synchronize", [](HybridEnnio* self, const auto&, auto& r) {
            self->synchronize();
            r.success = true;
        }},

        // ---- Alerts ----
        { "isAlertPresent", [](HybridEnnio* self, const auto&, auto& r) {
            r.success = true;
            r.data = self->isAlertPresent() ? "true" : "false";
        }},
        { "getAlertText", [](HybridEnnio* self, const auto&, auto& r) {
            r.success = true;
            r.data = "\"" + escapeJsonString(self->getAlertText()) + "\"";
        }},
        { "getAlertButtons", [](HybridEnnio* self, const auto&, auto& r) {
            auto buttons = self->getAlertButtons();
            std::ostringstream oss;
            oss << "[";
            for (size_t i = 0; i < buttons.size(); i++) {
                if (i > 0) oss << ",";
                oss << "\"" << escapeJsonString(buttons[i]) << "\"";
            }
            oss << "]";
            r.success = true;
            r.data = oss.str();
        }},
        { "tapAlertButton", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->tapAlertButton(::ennio::json::parseString(req.payload, "buttonText"));
        }},
        { "dismissAlert", [](HybridEnnio* self, const auto&, auto& r) {
            r.success = self->dismissAlert();
        }},

        // ---- Selector queries ----
        { "findBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            auto result = self->findBySelector(::ennio::json::parseString(req.payload, "selector"));
            r.success = true;
            r.data = std::holds_alternative<nitro::NullType>(result)
                     ? "null"
                     : elementInfoToJson(std::get<ExtendedElementInfo>(result));
        }},
        { "findAllBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            auto results = self->findAllBySelector(::ennio::json::parseString(req.payload, "selector"));
            std::ostringstream oss;
            oss << "[";
            for (size_t i = 0; i < results.size(); i++) {
                if (i > 0) oss << ",";
                oss << elementInfoToJson(results[i]);
            }
            oss << "]";
            r.success = true;
            r.data = oss.str();
        }},
        { "existsBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = true;
            r.data = self->existsBySelector(::ennio::json::parseString(req.payload, "selector")) ? "true" : "false";
        }},
        { "getTextBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            auto result = self->getTextBySelector(::ennio::json::parseString(req.payload, "selector"));
            r.success = true;
            r.data = std::holds_alternative<nitro::NullType>(result)
                     ? "null"
                     : "\"" + escapeJsonString(std::get<std::string>(result)) + "\"";
        }},
        { "isVisibleBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = true;
            r.data = self->isVisibleBySelector(::ennio::json::parseString(req.payload, "selector")) ? "true" : "false";
        }},

        // ---- Direct writes (UIKit/Fabric in-process) ----
        { "tap", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->tap(::ennio::json::parseString(req.payload, "testID"));
        }},
        { "tapAtPoint", [](HybridEnnio*, const auto& req, auto& r) {
            // Window-coordinate tap. CLI sends absolute logical points.
            r.success = ::ennio::EnnioRuntimeHelper::getInstance().tapAtScreenPoint(
                ::ennio::json::parseDouble(req.payload, "x"),
                ::ennio::json::parseDouble(req.payload, "y"));
        }},
        { "swipeAtPoints", [](HybridEnnio*, const auto& req, auto& r) {
            // Window-coordinate pan: (x1,y1)→(x2,y2) over durationMs.
            // Replaces idb HID swipe — used for cross-screen drags and
            // horizontal carousel panning that doesn't bind to a
            // UIScrollView's scroll axis.
            r.success = ::ennio::EnnioRuntimeHelper::getInstance().swipeAtPoints(
                ::ennio::json::parseDouble(req.payload, "x1"),
                ::ennio::json::parseDouble(req.payload, "y1"),
                ::ennio::json::parseDouble(req.payload, "x2"),
                ::ennio::json::parseDouble(req.payload, "y2"),
                static_cast<int>(::ennio::json::parseDouble(req.payload, "durationMs")));
        }},
        { "pressHardwareKey", [](HybridEnnio*, const auto& req, auto& r) {
            r.success = ::ennio::EnnioRuntimeHelper::getInstance().pressHardwareKey(
                static_cast<int>(::ennio::json::parseDouble(req.payload, "keyCode")));
        }},
        { "getSurfaceOffset", [](HybridEnnio*, const auto&, auto& r) {
            // React-surface origin in the user app's window. Lets the
            // CLI translate Fabric's surface-relative `screenX/screenY`
            // into idb's window-relative coords.
            auto offset = ::ennio::EnnioRuntimeHelper::getInstance().getSurfaceOffset();
            std::ostringstream oss;
            oss << "{\"x\":" << offset.first << ",\"y\":" << offset.second << "}";
            r.data = oss.str();
            r.success = true;
        }},
        { "getViewWindowFrameByLabel", [](HybridEnnio*, const auto& req, auto& r) {
            auto frame = ::ennio::EnnioRuntimeHelper::getInstance().getViewWindowFrameByLabel(
                ::ennio::json::parseString(req.payload, "text"));
            std::ostringstream oss;
            oss << "{\"x\":" << std::get<0>(frame) << ",\"y\":" << std::get<1>(frame)
                << ",\"width\":" << std::get<2>(frame) << ",\"height\":" << std::get<3>(frame) << "}";
            r.data = oss.str();
            r.success = std::get<2>(frame) > 0 && std::get<3>(frame) > 0;
        }},
        { "getViewWindowFrame", [](HybridEnnio*, const auto& req, auto& r) {
            // Window-relative UIView frame for a testID. Bypasses Fabric's
            // surface-relative layout — already accounts for ScrollView
            // contentInsetAdjustment, safe-area, modal presentations,
            // and any other runtime offsets UIKit applies.
            auto frame = ::ennio::EnnioRuntimeHelper::getInstance().getViewWindowFrame(
                ::ennio::json::parseString(req.payload, "testID"));
            std::ostringstream oss;
            oss << "{\"x\":" << std::get<0>(frame) << ",\"y\":" << std::get<1>(frame)
                << ",\"width\":" << std::get<2>(frame) << ",\"height\":" << std::get<3>(frame) << "}";
            r.data = oss.str();
            r.success = std::get<2>(frame) > 0 && std::get<3>(frame) > 0;
        }},
        { "tapByLabel", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->tapByLabel(::ennio::json::parseString(req.payload, "text"));
        }},
        { "doubleTap", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->doubleTap(::ennio::json::parseString(req.payload, "testID"));
        }},
        { "longPress", [](HybridEnnio* self, const auto& req, auto& r) {
            std::string tid = ::ennio::json::parseString(req.payload, "testID");
            double duration = ::ennio::json::parseDouble(req.payload, "duration");
            // Caller didn't supply a positive duration — use the maestro
            // default rather than passing 0 down to the gesture (which
            // would make it a tap). Log so caller bugs are visible.
            if (duration <= 0) {
                ENNIO_LOG_DEBUG_F(LOG_TAG, "longPress: duration<=0, defaulting to 500ms");
                duration = 500;
            }
            r.success = self->longPress(tid, duration);
        }},
        { "typeText", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->typeText(
                ::ennio::json::parseString(req.payload, "testID"),
                ::ennio::json::parseString(req.payload, "text"));
        }},
        { "clearText", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->clearText(::ennio::json::parseString(req.payload, "testID"));
        }},
        { "eraseText", [](HybridEnnio* self, const auto& req, auto& r) {
            std::string tid = ::ennio::json::parseString(req.payload, "testID");
            double count = ::ennio::json::parseDouble(req.payload, "count");
            if (count <= 0) count = 1;
            r.success = self->eraseText(tid, count);
        }},
        { "pressKey", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->pressKey(
                ::ennio::json::parseString(req.payload, "testID"),
                ::ennio::json::parseString(req.payload, "keyName"));
        }},
        { "scroll", [](HybridEnnio* self, const auto& req, auto& r) {
            std::string tid = ::ennio::json::parseString(req.payload, "testID");
            std::string dir = ::ennio::json::parseString(req.payload, "direction");
            if (dir.empty()) dir = "down";
            double dist = ::ennio::json::parseDouble(req.payload, "distance");
            if (dist <= 0) dist = 200;
            ScrollDirection sd = ScrollDirection::DOWN;
            if (dir == "up") sd = ScrollDirection::UP;
            else if (dir == "left") sd = ScrollDirection::LEFT;
            else if (dir == "right") sd = ScrollDirection::RIGHT;
            r.success = self->scroll(tid, sd, dist);
        }},
        { "swipe", [](HybridEnnio* self, const auto& req, auto& r) {
            std::string tid = ::ennio::json::parseString(req.payload, "testID");
            std::string dir = ::ennio::json::parseString(req.payload, "direction");
            if (dir.empty()) dir = "down";
            double dist = ::ennio::json::parseDouble(req.payload, "distance");
            if (dist <= 0) dist = 200;
            ScrollDirection sd = ScrollDirection::DOWN;
            if (dir == "up") sd = ScrollDirection::UP;
            else if (dir == "left") sd = ScrollDirection::LEFT;
            else if (dir == "right") sd = ScrollDirection::RIGHT;
            r.success = self->swipe(tid, sd, dist);
        }},
        { "scrollTo", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->scrollTo(
                ::ennio::json::parseString(req.payload, "scrollViewTestID"),
                ::ennio::json::parseString(req.payload, "elementTestID"));
        }},
        { "tapTab", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->tapTab(::ennio::json::parseDouble(req.payload, "index"));
        }},
        { "tapTabByName", [](HybridEnnio*, const auto& req, auto& r) {
            r.success = ::ennio::EnnioRuntimeHelper::getInstance().tapTabByName(
                ::ennio::json::parseString(req.payload, "name"));
        }},
        { "fireTap", [](HybridEnnio*, const auto& req, auto& r) {
            r.success = ::ennio::EnnioRuntimeHelper::getInstance().fireTapByTestID(
                ::ennio::json::parseString(req.payload, "testID"));
        }},
        { "invokeOnPress", [](HybridEnnio* self, const auto& req, auto& r) {
            // Visibility gate. The fiber walk would happily call onPress
            // on a fiber whose host view is offscreen / not laid out — a
            // tap a real finger could never deliver. Refuse, force the
            // caller to scroll first. Some custom button libraries (RNGH
            // BaseButton, pressto) don't propagate testID to UIView's
            // accessibilityIdentifier consistently — when the UIView
            // can't be located by id, fall back to the Fabric shadow
            // tree's visibility instead of refusing outright. That
            // covers Modal-rendered options whose UIView mount lags the
            // shadow tree by a frame.
            auto testID = ::ennio::json::parseString(req.payload, "testID");
            auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
            bool viewOnscreen = helper.isViewOnscreen(testID);
            if (!viewOnscreen) {
                auto layoutVariant = self->getLayoutMetrics(testID);
                bool fabricOnscreen = false;
                if (auto layout = std::get_if<LayoutMetrics>(&layoutVariant)) {
                    if (layout->width > 0 && layout->height > 0) {
                        fabricOnscreen = true;
                    }
                }
                if (!fabricOnscreen) {
                    r.success = false;
                    r.error = "Element not in viewport: " + testID;
                    return;
                }
            }
            // Schedules the Fiber walk on the JS thread via the Nitro
            // Dispatcher captured by `bindRuntime` at boot. Blocks the WS
            // thread on a condition variable until JS signals completion
            // or the 1500 ms timeout fires.
            r.success = HybridEnnio::invokeOnPressFromCpp(testID);
        }},
        { "getReadyCoord", [](HybridEnnio*, const auto& req, auto& r) {
            auto frame = ::ennio::EnnioRuntimeHelper::getInstance().getReadyCoord(
                ::ennio::json::parseString(req.payload, "testID"),
                static_cast<int>(::ennio::json::parseDouble(req.payload, "maxWaitMs")));
            std::ostringstream oss;
            oss << "{\"x\":" << std::get<0>(frame) << ",\"y\":" << std::get<1>(frame)
                << ",\"width\":" << std::get<2>(frame) << ",\"height\":" << std::get<3>(frame) << "}";
            r.data = oss.str();
            r.success = std::get<2>(frame) > 0 && std::get<3>(frame) > 0;
        }},
        { "backGesture",  [](HybridEnnio* self, const auto&, auto& r) { r.success = self->backGesture(); }},
        { "hideKeyboard", [](HybridEnnio* self, const auto&, auto& r) { r.success = self->hideKeyboard(); }},

        // ---- Selector-anchored writes ----
        { "tapBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->tapBySelector(::ennio::json::parseString(req.payload, "selector"));
        }},
        { "doubleTapBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->doubleTapBySelector(::ennio::json::parseString(req.payload, "selector"));
        }},
        { "longPressBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            std::string sel = ::ennio::json::parseString(req.payload, "selector");
            double duration = ::ennio::json::parseDouble(req.payload, "duration");
            if (duration <= 0) duration = 500;
            r.success = self->longPressBySelector(sel, duration);
        }},
        { "typeTextBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->typeTextBySelector(
                ::ennio::json::parseString(req.payload, "selector"),
                ::ennio::json::parseString(req.payload, "text"));
        }},
        { "clearTextBySelector", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->clearTextBySelector(::ennio::json::parseString(req.payload, "selector"));
        }},

        // ---- Pasteboard ----
        { "copyToClipboard", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->copyToClipboard(::ennio::json::parseString(req.payload, "text"));
        }},
        { "pasteFromClipboard", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->pasteFromClipboard(::ennio::json::parseString(req.payload, "testID"));
        }},
        { "getClipboardText", [](HybridEnnio* self, const auto&, auto& r) {
            r.success = true;
            r.data = "\"" + escapeJsonString(self->getClipboardText()) + "\"";
        }},
    };
    (void)helper;  // suppress unused-capture-style warnings on some compilers.
    return handlers;
}

::ennio::Response HybridEnnio::handleCommand(const ::ennio::Request& request) {
    ::ennio::Response response;
    response.id = request.id;

    ENNIO_LOG_DEBUG_F(LOG_TAG, "handleCommand: type=%s", request.type.c_str());

    const auto& handlers = commandHandlers();
    auto it = handlers.find(request.type);
    if (it == handlers.end()) {
        response.success = false;
        response.error = "Unknown command: " + request.type;
        return response;
    }
    try {
        it->second(this, request, response);
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
    // Find the node in the Fabric shadow tree → grab its window-coord
    // centre → synthesise a UITouch at that point. UIKit's hit-test
    // routes the touch through the responder chain, so onPress fires
    // for whatever view is on top: UIControl, Pressable, RNGH BaseButton.
    // ~5 ms in-process, no UIView walk, no chain of activation guesses.
    auto root = getShadowTreeRoot();
    if (!root) return false;
    auto metrics = ::ennio::ShadowTreeTraverser::getLayoutMetrics(root, testID);
    if (!metrics || metrics->width <= 0 || metrics->height <= 0) return false;
    double cx = metrics->screenX + metrics->width / 2.0;
    double cy = metrics->screenY + metrics->height / 2.0;
    return ::ennio::EnnioRuntimeHelper::getInstance().tapAtScreenPoint(cx, cy);
}
bool HybridEnnio::tapByLabel(const std::string& text) {
    // Match by text in Fabric tree → tap at the matched node's
    // window-coord centre. Covers Pressable inner Text, TextInput
    // placeholder, custom card text.
    ::ennio::SelectorCriteria criteria;
    criteria.text = ::ennio::TextMatcher{text, ::ennio::TextMatchMode::Contains};
    auto root = getShadowTreeRoot();
    if (root) {
        auto node = ::ennio::ElementMatcher::findFirst(root, criteria);
        if (node) {
            auto info = ::ennio::ElementMatcher::getExtendedElementInfo(root, node);
            if (info && info->layout.width > 0 && info->layout.height > 0) {
                double cx = info->layout.screenX + info->layout.width / 2.0;
                double cy = info->layout.screenY + info->layout.height / 2.0;
                if (::ennio::EnnioRuntimeHelper::getInstance().tapAtScreenPoint(cx, cy)) {
                    return true;
                }
            }
        }
    }
    // Native widgets that don't show up in the Fabric shadow tree
    // (UITabBar items, system alert buttons, RNScreens-presented stack
    // headers) — walk the UIKit accessibility tree and fire the
    // matched widget's activation. This is the ONLY remaining UIKit
    // path; everything else goes through layout-coord.
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
bool HybridEnnio::swipeAtPoints(double x1, double y1, double x2, double y2, double durationMs) {
    return ::ennio::EnnioRuntimeHelper::getInstance().swipeAtPoints(x1, y1, x2, y2, durationMs);
}
bool HybridEnnio::pressHardwareKey(double keyCode) {
    return ::ennio::EnnioRuntimeHelper::getInstance().pressHardwareKey(keyCode);
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

// Non-Apple stubs so the spec can still build. Android writes are out
// of scope — they need UIAutomator + a different in-process surface.
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
bool HybridEnnio::swipeAtPoints(double, double, double, double, double) { return false; }
bool HybridEnnio::pressHardwareKey(double) { return false; }
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

// Pass `self` by mutable reference: `findBySelector` acquires the
// instance mutex internally, so it can't be called from a const context.
// Callers all hold a non-const `*this`, so this is a pure type-system
// fix — no `const_cast`, no behavioural change.
std::optional<std::string> resolveSelectorToTestID(
    HybridEnnio& self,
    const std::string& selectorJson
) {
    auto found = self.findBySelector(selectorJson);
    if (std::holds_alternative<nitro::NullType>(found)) return std::nullopt;
    auto info = std::get<ExtendedElementInfo>(found);
    if (info.testID.empty()) return std::nullopt;
    return info.testID;
}

} // namespace

bool HybridEnnio::tapBySelector(const std::string& selectorJson) {
    // Resolve selector via Fabric shadow tree → tap at the matched
    // node's window-coord centre. Single path, no UIView walk, no
    // testID-resolution chain.
    auto& mutSelf = *this;
    auto found = mutSelf.findBySelector(selectorJson);
    if (std::holds_alternative<nitro::NullType>(found)) return false;
    const auto info = std::get<ExtendedElementInfo>(found);
    const auto& layout = info.layout;
    if (layout.width <= 0 || layout.height <= 0) return false;
    double cx = layout.screenX + layout.width / 2.0;
    double cy = layout.screenY + layout.height / 2.0;
    return ::ennio::EnnioRuntimeHelper::getInstance().tapAtScreenPoint(cx, cy);
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

// ============================================
// JS bridge: runtime + dispatcher capture, fiber walker install,
// WS-thread → JS-thread invokeOnPress dispatch.
// ============================================

// React Fiber walker — installed onto globalThis once at boot. Invokes
// the React onPress closure synchronously, bypassing iOS's gesture
// pipeline. Living in a C++ string keeps app-side glue minimal: the
// only JS the app touches is a one-line `__bindRuntime()` call after
// createHybridObject.
namespace {
    constexpr const char* kFiberWalkerSource = R"JS(
(function () {
  function findFiberByTestID(fiber, testID) {
    if (!fiber) return null;
    if (fiber.memoizedProps && fiber.memoizedProps.testID === testID) return fiber;
    var found = findFiberByTestID(fiber.child, testID);
    if (found) return found;
    return findFiberByTestID(fiber.sibling, testID);
  }
  // pointerEvents semantics (RN matches web):
  //   "none"     — view + descendants are not touch targets.
  //   "box-only" — view is a target, descendants are not.
  //   "box-none" — view is not a target, descendants are.
  //   "auto"     — both target.
  // Walk the fiber chain (.return) and reject if the target's chain has
  // a pointerEvents value that would block a real finger.
  function pointerEventsBlocks(target) {
    for (var cursor = target; cursor; cursor = cursor.return) {
      var pe = cursor.memoizedProps && cursor.memoizedProps.pointerEvents;
      if (pe === 'none') return true;
      if (pe === 'box-only' && cursor !== target) return true;
    }
    return false;
  }
  globalThis.__ennio_invokeOnPress = function (testID) {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.getFiberRoots) return false;
    var iter = hook.renderers.entries();
    while (true) {
      var step = iter.next();
      if (step.done) break;
      var rendererID = typeof step.value[0] === 'number' ? step.value[0] : 1;
      var roots;
      try { roots = hook.getFiberRoots(rendererID); } catch (e) { continue; }
      if (!roots) continue;
      var rootsIter = roots.values();
      while (true) {
        var r = rootsIter.next();
        if (r.done) break;
        var fiber = findFiberByTestID(r.value && r.value.current, testID);
        if (!fiber) continue;
        if (pointerEventsBlocks(fiber)) return false;
        var onPress = fiber.memoizedProps && fiber.memoizedProps.onPress;
        if (typeof onPress === 'function') {
          try {
            onPress({
              nativeEvent: {},
              currentTarget: null,
              target: null,
              preventDefault: function () {},
              stopPropagation: function () {},
              persist: function () {},
            });
            return true;
          } catch (e) { return false; }
        }
      }
    }
    return false;
  };
})();
)JS";

    std::mutex g_jsContextMutex;
    facebook::jsi::Runtime* g_jsRuntime = nullptr;
    HybridEnnio::JSThreadExecutor g_jsExecutor;

    std::mutex g_instanceMutex;
    std::shared_ptr<HybridEnnio> g_instance;
}

void HybridEnnio::setJSThreadExecutor(HybridEnnio::JSThreadExecutor exec) {
    std::lock_guard<std::mutex> lock(g_jsContextMutex);
    g_jsExecutor = std::move(exec);
}

void HybridEnnio::nativeBootstrap(facebook::jsi::Runtime& runtime, int port) {
    {
        std::lock_guard<std::mutex> lock(g_jsContextMutex);
        if (g_jsRuntime == nullptr) {
            g_jsRuntime = &runtime;
        }
    }

    try {
        runtime.evaluateJavaScript(
            std::make_shared<facebook::jsi::StringBuffer>(std::string(kFiberWalkerSource)),
            "ennio_fiber_walker.js");
    } catch (const std::exception& e) {
        ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("nativeBootstrap: walker eval failed: " << e.what()));
        return;
    }

    std::shared_ptr<HybridEnnio> instance;
    {
        std::lock_guard<std::mutex> lock(g_instanceMutex);
        if (!g_instance) {
            try {
                g_instance = std::make_shared<HybridEnnio>();
            } catch (const std::exception& e) {
                ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("nativeBootstrap: ctor threw: " << e.what()));
                return;
            }
        }
        instance = g_instance;
    }
    if (!instance->isServerRunning()) {
        try {
            instance->startServer(static_cast<double>(port));
        } catch (const std::exception& e) {
            ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("nativeBootstrap: startServer threw: " << e.what()));
        }
    }
}

bool HybridEnnio::invokeOnPressFromCpp(const std::string& testID) {
    JSThreadExecutor executor;
    {
        std::lock_guard<std::mutex> lock(g_jsContextMutex);
        executor = g_jsExecutor;
    }
    if (!executor) {
        // Bootstrap hasn't run yet — caller falls back to idb HID tap.
        return false;
    }

    // Schedule on JS thread, block here on a heap-allocated cv slot
    // (closure may outlive the waiter on timeout, so the slot can't
    // live on the WS thread's stack).
    struct Slot {
        std::mutex m;
        std::condition_variable cv;
        bool ready = false;
        bool success = false;
    };
    auto slot = std::make_shared<Slot>();
    std::string id = testID;

    executor([slot, id](facebook::jsi::Runtime& rt) {
        bool ok = false;
        try {
            auto fn = rt.global().getProperty(rt, "__ennio_invokeOnPress");
            if (fn.isObject() && fn.asObject(rt).isFunction(rt)) {
                auto result = fn.asObject(rt)
                    .asFunction(rt)
                    .call(rt, facebook::jsi::String::createFromUtf8(rt, id));
                ok = result.isBool() && result.getBool();
            }
        } catch (...) {
            ok = false;
        }
        std::lock_guard<std::mutex> lock(slot->m);
        slot->success = ok;
        slot->ready = true;
        slot->cv.notify_one();
    });

    std::unique_lock<std::mutex> lock(slot->m);
    bool finished = slot->cv.wait_for(lock, std::chrono::milliseconds(1500),
                                       [&]() { return slot->ready; });
    return finished && slot->success;
}

} // namespace margelo::nitro::ennio
