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
#include <cstdio>
#include <cstdlib>
#include <cerrno>

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
// Element Queries
// ============================================

bool HybridEnnio::exists(const std::string& testID) {
    if (findNode(testID) != nullptr) {
        return true;
    }

    return false;
}

bool HybridEnnio::isVisible(const std::string& testID) {
    // UIKit is authoritative. The UIView either has a key-window frame
    // that intersects the visible bounds, or it doesn't. Window-relative
    // frame respects ScrollView offset (shadow-tree screenY does not),
    // so a view at content-Y=2000 in a 900px-tall window correctly
    // reports "not visible" until the user scrolls to it.
    //
    // We deliberately do NOT fall through to the Fabric shadow tree
    // when the UIView is missing or detached. Modal's `visible={false}`
    // dismisses the presented VC but the JSX subtree stays mounted in
    // the fiber tree — falling through would say a closed modal is
    // still visible. For virtualized cells the caller can scroll until
    // the cell mounts; the visibility primitive itself stays UIKit-
    // anchored.
    auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
    auto frame = helper.getViewWindowFrame(testID);
    bool uiViewMounted = std::get<2>(frame) > 0 && std::get<3>(frame) > 0;
    if (!uiViewMounted) return false;
    return helper.isViewOnscreen(testID);
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

// Commit signal — incremented from the JS thread via
// __ennio_native_onCommit (a JSI HostFunction installed in
// nativeBootstrap). waitForNextCommit blocks on this counter +
// condition variable until the value advances or maxMs elapses.
namespace {
    std::mutex g_commitMutex;
    std::condition_variable g_commitCv;
    std::atomic<uint64_t> g_commitCounter{0};
}

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

bool HybridEnnio::waitForNextCommit(double maxMs) {
    // Snapshot the current counter; wake when JS bumps it (via the
    // __ennio_native_onCommit HostFunction installed in
    // nativeBootstrap). Cap at maxMs so the worst case is identical
    // to a blind sleep of the same duration — no flake risk.
    uint64_t startId = g_commitCounter.load(std::memory_order_acquire);
    auto deadline = std::chrono::steady_clock::now()
                  + std::chrono::milliseconds(static_cast<long>(maxMs));
    std::unique_lock<std::mutex> lock(g_commitMutex);
    return g_commitCv.wait_until(lock, deadline, [&] {
        return g_commitCounter.load(std::memory_order_acquire) > startId;
    });
}

// ============================================
// Command Dispatch
// ============================================
//
// Each handler is `(self, request, response)` — parse args, call the
// instance method, fill the response. Map lookup is O(1). Reached
// either from the legacy in-app WS server (removed) or — in v2 — from
// the JSI `__ennioDispatch` host function the CLI calls via Hermes
// Inspector. Same dispatch table, two transports.

using HandlerFn = std::function<void(HybridEnnio*, const ::ennio::Request&, ::ennio::Response&)>;

static const std::unordered_map<std::string, HandlerFn>& commandHandlers() {
    static const std::unordered_map<std::string, HandlerFn> handlers = {
        // ---- Read queries ----
        { "exists", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = true;
            r.data = self->exists(::ennio::json::parseString(req.payload, "testID")) ? "true" : "false";
        }},
        { "isVisible", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = true;
            r.data = self->isVisible(::ennio::json::parseString(req.payload, "testID")) ? "true" : "false";
        }},
        { "isMenuTriggerAncestor", [](HybridEnnio*, const auto& req, auto& r) {
            r.success = true;
            r.data = ::ennio::EnnioRuntimeHelper::getInstance().isMenuTriggerAncestor(
                ::ennio::json::parseString(req.payload, "testID")) ? "true" : "false";
        }},
        { "clearAppData", [](HybridEnnio*, const auto&, auto& r) {
            // In-process sandbox wipe (Library/, Documents/, tmp/). Works
            // identically on Simulator and physical device — no host
            // filesystem access required. Caller restarts the app
            // afterwards to drop in-memory state.
            r.success = ::ennio::EnnioRuntimeHelper::getInstance().clearAppDataDirectories();
        }},
        { "getText", [](HybridEnnio* self, const auto& req, auto& r) {
            auto result = self->getText(::ennio::json::parseString(req.payload, "testID"));
            r.success = true;
            r.data = std::holds_alternative<nitro::NullType>(result)
                     ? "null"
                     : "\"" + escapeJsonString(std::get<std::string>(result)) + "\"";
        }},

        // ---- Synchronization ----
        { "waitForIdle", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->waitForIdle(::ennio::json::parseDouble(req.payload, "timeout"));
        }},
        { "synchronize", [](HybridEnnio* self, const auto&, auto& r) {
            self->synchronize();
            r.success = true;
        }},
        { "waitForCommit", [](HybridEnnio* self, const auto& req, auto& r) {
            double maxMs = ::ennio::json::parseDouble(req.payload, "maxMs");
            auto start = std::chrono::steady_clock::now();
            bool gotCommit = self->waitForNextCommit(maxMs);
            auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start).count();
            r.success = true;
            // JSON: { "commit": true|false, "elapsedMs": N }
            std::ostringstream oss;
            oss << "{\"commit\":" << (gotCommit ? "true" : "false")
                << ",\"elapsedMs\":" << elapsedMs << "}";
            r.data = oss.str();
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
        { "prepareTap", [](HybridEnnio*, const auto& req, auto& r) {
            // Batched: stable-coord poll + auto-scroll + UIMenu check
            // in one JSI call. Saves ~5-10 CDP round trips per tap vs
            // letting the CLI run the poll loop. Empty result string
            // = the testID couldn't be measured on-screen. The actual
            // tap still uses idb HID — UITouch synth misfires on
            // RNGH-wrapped pressables.
            auto out = ::ennio::EnnioRuntimeHelper::getInstance().prepareTap(
                ::ennio::json::parseString(req.payload, "testID"),
                ::ennio::json::parseDouble(req.payload, "screenW"),
                ::ennio::json::parseDouble(req.payload, "screenH"));
            if (out.empty()) {
                r.success = false;
            } else {
                r.success = true;
                r.data = out;
            }
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
        { "getKeyWindowSize", [](HybridEnnio*, const auto&, auto& r) {
            auto sz = ::ennio::EnnioRuntimeHelper::getInstance().getKeyWindowSize();
            std::ostringstream oss;
            oss << "{\"width\":" << sz.first << ",\"height\":" << sz.second << "}";
            r.data = oss.str();
            r.success = sz.first > 0 && sz.second > 0;
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
        { "scrollTo", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->scrollTo(
                ::ennio::json::parseString(req.payload, "scrollViewTestID"),
                ::ennio::json::parseString(req.payload, "elementTestID"));
        }},
        { "tapTabByName", [](HybridEnnio*, const auto& req, auto& r) {
            r.success = ::ennio::EnnioRuntimeHelper::getInstance().tapTabByName(
                ::ennio::json::parseString(req.payload, "name"));
        }},
        { "backGesture",  [](HybridEnnio* self, const auto&, auto& r) { r.success = self->backGesture(); }},
        { "hideKeyboard", [](HybridEnnio* self, const auto&, auto& r) { r.success = self->hideKeyboard(); }},

        // ---- Pasteboard ----
        { "copyToClipboard", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->copyToClipboard(::ennio::json::parseString(req.payload, "text"));
        }},
        { "pasteFromClipboard", [](HybridEnnio* self, const auto& req, auto& r) {
            r.success = self->pasteFromClipboard(::ennio::json::parseString(req.payload, "testID"));
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

        // Walk all matches and prefer the first whose testID resolves to
        // a UIView in the iOS a11y tree. Stops shadow-only matches under
        // inactive tabs / pushed stack frames from being "found" and
        // subsequently tapped against a stale UIView. Matches without
        // testIDs fall through to first-match (text/trait-only selectors).
        auto nodes = ::ennio::ElementMatcher::findAll(root, criteria);
        if (nodes.empty()) {
            return nitro::NullType();
        }

        auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
        std::shared_ptr<const facebook::react::ShadowNode> chosen;
        for (const auto& node : nodes) {
            auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
            if (!testID) continue;
            if (helper.isInA11yTree(*testID)) { chosen = node; break; }
        }
        if (!chosen) {
            // No a11y-visible testID match. If any node lacks a testID,
            // fall back to the first shadow-tree match (preserves current
            // behavior for text-only / trait-only queries).
            for (const auto& node : nodes) {
                if (!::ennio::ShadowTreeTraverser::getTestID(*node)) { chosen = node; break; }
            }
        }
        if (!chosen) {
            return nitro::NullType();
        }

        auto infoOpt = ::ennio::ElementMatcher::getExtendedElementInfo(root, chosen);
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
        // a11y filter: drop testID-bearing matches whose UIView isn't in
        // the iOS a11y tree (inactive tab / pushed frame / occluded
        // modal host). Matches without testIDs are kept — caller handles
        // visibility separately for those.
        auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
        for (const auto& node : nodes) {
            auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
            if (testID && !helper.isInA11yTree(*testID)) continue;
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
        if (!root) return false;

        // Walk all matches; if any with a testID is in the iOS a11y tree,
        // it exists. Falls back to "any shadow match" when matches lack
        // testIDs (text-only selectors) — the visibility gate is the
        // proper place to enforce a11y for those.
        auto nodes = ::ennio::ElementMatcher::findAll(root, criteria);
        if (nodes.empty()) return false;

        auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
        bool hadTestID = false;
        for (const auto& node : nodes) {
            auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
            if (!testID) continue;
            hadTestID = true;
            if (helper.isInA11yTree(*testID)) return true;
        }
        // No testID-bearing match: fall back to shadow-tree presence.
        return !hadTestID;
    } catch (const std::exception& e) {
        ENNIO_LOG_ERROR("existsBySelector", "Parse error: " << e.what());
        return false;
    }
}

std::variant<nitro::NullType, std::string> HybridEnnio::getTextBySelector(const std::string& selectorJson) {
    try {
        auto criteria = ::ennio::SelectorParser::parse(selectorJson);
        auto root = getShadowTreeRoot();
        if (!root) {
            return nitro::NullType();
        }

        // Same a11y filter as findBySelector: prefer the first match
        // whose testID is in the iOS a11y tree; fall back to the first
        // testID-less match.
        auto nodes = ::ennio::ElementMatcher::findAll(root, criteria);
        if (nodes.empty()) {
            return nitro::NullType();
        }

        auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
        std::shared_ptr<const facebook::react::ShadowNode> chosen;
        for (const auto& node : nodes) {
            auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
            if (!testID) continue;
            if (helper.isInA11yTree(*testID)) { chosen = node; break; }
        }
        if (!chosen) {
            for (const auto& node : nodes) {
                if (!::ennio::ShadowTreeTraverser::getTestID(*node)) { chosen = node; break; }
            }
        }
        if (!chosen) {
            return nitro::NullType();
        }

        auto text = ::ennio::ShadowTreeTraverser::getText(chosen);
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

        auto& helper = ::ennio::EnnioRuntimeHelper::getInstance();
        for (const auto& node : nodes) {
            auto testID = ::ennio::ShadowTreeTraverser::getTestID(*node);
            if (testID) {
                // Defer to the UIKit visibility path: it honors the iOS
                // a11y tree (accessibilityElementsHidden), which catches
                // matches under inactive tabs / pushed-under stack frames
                // that the shadow-tree-only check would falsely accept.
                if (helper.isViewOnscreen(*testID)) {
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

bool HybridEnnio::scroll(const std::string& testID, ScrollDirection direction, double distance) {
    return ::ennio::EnnioRuntimeHelper::getInstance().scroll(testID, scrollDirectionToString(direction), distance);
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

#else

// Non-Apple stubs so the spec can still build. Android writes are out
// of scope — they need UIAutomator + a different in-process surface.
bool HybridEnnio::scroll(const std::string&, ScrollDirection, double) { return false; }
bool HybridEnnio::scrollTo(const std::string&, const std::string&) { return false; }
bool HybridEnnio::swipeAtPoints(double, double, double, double, double) { return false; }
bool HybridEnnio::pressHardwareKey(double) { return false; }
bool HybridEnnio::backGesture() { return false; }
bool HybridEnnio::hideKeyboard() { return false; }
bool HybridEnnio::tapAlertButton(const std::string&) { return false; }
bool HybridEnnio::dismissAlert() { return false; }
bool HybridEnnio::copyToClipboard(const std::string&) { return false; }
bool HybridEnnio::pasteFromClipboard(const std::string&) { return false; }

#endif

// ============================================
// JS bridge: runtime capture + commit-signal install.
// ============================================

// React Fiber walker — installed onto globalThis once at boot. Invokes
// the React onPress closure synchronously, bypassing iOS's gesture
// pipeline. Living in a C++ string keeps app-side glue minimal: the
// only JS the app touches is a one-line `__bindRuntime()` call after
// createHybridObject.
namespace {
    constexpr const char* kFiberWalkerSource = R"JS(
(function () {
  // Commit signal — monkey-patch onCommitFiberRoot so the native
  // side learns the moment React finishes a commit. Same pattern
  // React DevTools uses; stable across React versions. The native
  // callback is installed by HybridEnnio::nativeBootstrap right
  // after this snippet is evaluated.
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && typeof hook.onCommitFiberRoot === 'function') {
    var originalOnCommit = hook.onCommitFiberRoot.bind(hook);
    hook.onCommitFiberRoot = function (rendererID, root, priorityLevel, didError) {
      try { originalOnCommit(rendererID, root, priorityLevel, didError); } catch (e) {}
      if (typeof globalThis.__ennio_native_onCommit === 'function') {
        try { globalThis.__ennio_native_onCommit(); } catch (e) {}
      }
    };
  }
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

    // Install __ennio_native_onCommit as a JSI HostFunction. The
    // monkey-patched onCommitFiberRoot in the walker calls this on
    // every React commit; we bump the counter and wake any thread
    // waiting in waitForNextCommit. Idempotent — overwrites on each
    // bootstrap.
    try {
        auto onCommitFn = facebook::jsi::Function::createFromHostFunction(
            runtime,
            facebook::jsi::PropNameID::forAscii(runtime, "__ennio_native_onCommit"),
            0,
            [](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value*, size_t) -> facebook::jsi::Value {
                auto next = g_commitCounter.fetch_add(1, std::memory_order_release) + 1;
                g_commitCv.notify_all();
                // Mirror to a JS-readable global so the external CLI can
                // poll commits via `Runtime.evaluate` without going through
                // the slow async-token path.
                try {
                    rt.global().setProperty(
                        rt,
                        "__ennioCommitCounter",
                        facebook::jsi::Value(static_cast<double>(next)));
                } catch (...) {
                    /* runtime might be transitioning; commit signal still wakes the cv */
                }
                return facebook::jsi::Value::undefined();
            });
        runtime.global().setProperty(runtime, "__ennio_native_onCommit", onCommitFn);
        // Seed the JS-visible counter so the CLI's first read returns 0
        // instead of `undefined` before any commit fires.
        runtime.global().setProperty(runtime, "__ennioCommitCounter", facebook::jsi::Value(0.0));
    } catch (const std::exception& e) {
        ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("nativeBootstrap: onCommit install failed: " << e.what()));
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
    (void)port;  // No longer used — transport is CDP via Hermes Inspector.

    // Seed the JS-side result bucket. External CLI posts work via
    // `__ennioDispatch(type, payloadJson, token)` and polls
    // `globalThis.__ennioResults[token]` until the background worker
    // writes a response.
    try {
        auto code = facebook::jsi::String::createFromUtf8(runtime,
            "globalThis.__ennioResults = globalThis.__ennioResults || {};");
        runtime.evaluateJavaScript(
            std::make_shared<facebook::jsi::StringBuffer>(
                "globalThis.__ennioResults = globalThis.__ennioResults || {};"),
            "ennio_results_seed.js");
        (void)code;
    } catch (const std::exception& e) {
        ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("nativeBootstrap: results seed failed: " << e.what()));
    }

    // Install `__ennioDispatch(type, payloadJson, token)` JSI host
    // function. Returns immediately to JS; spawns a background worker
    // that runs the existing command handlers and schedules a JS-thread
    // callback to write the response into `globalThis.__ennioResults`.
    //
    // Why async + poll vs. synchronous return?
    //   `waitForCommit` blocks until React fires `__ennio_native_onCommit`
    //   (a JS callback). If `__ennioDispatch` blocked the JS thread
    //   waiting for its worker, the React commit could never run and the
    //   waiter would deadlock. Async pattern: worker waits on the cv,
    //   JS thread stays free to advance React, commits fire, cv signals,
    //   worker finishes, result lands on globalThis. CLI polls.
    try {
        auto dispatchFn = facebook::jsi::Function::createFromHostFunction(
            runtime,
            facebook::jsi::PropNameID::forAscii(runtime, "__ennioDispatch"),
            3,
            [](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count) -> facebook::jsi::Value {
                if (count < 3) return facebook::jsi::Value::undefined();
                std::string type = args[0].getString(rt).utf8(rt);
                std::string payloadJson = args[1].getString(rt).utf8(rt);
                std::string token = args[2].getString(rt).utf8(rt);

                std::shared_ptr<HybridEnnio> inst;
                JSThreadExecutor exec;
                {
                    std::lock_guard<std::mutex> ilock(g_instanceMutex);
                    inst = g_instance;
                }
                {
                    std::lock_guard<std::mutex> jlock(g_jsContextMutex);
                    exec = g_jsExecutor;
                }
                if (!inst || !exec) {
                    return facebook::jsi::Value::undefined();
                }

                ::ennio::Request req;
                req.id = token;
                req.type = type;
                req.payload = payloadJson;

                // Fast path: most handlers run synchronously on the
                // main thread via `dispatchSyncMainWithTimeout`. Total
                // time on JS thread is ~1-10 ms — well under the
                // ~25 ms a CDP-poll round trip would cost. Run inline
                // and return the JSON directly to the CLI.
                //
                // Slow path: `waitForCommit` and `waitForIdle` wait
                // for the JS thread to run React commits, which can't
                // happen while THIS host function is blocking the JS
                // thread. They MUST go through the background worker
                // + JS-callback to leave the JS thread free for the
                // commits we're waiting on.
                const bool needsAsync = (type == "waitForCommit" || type == "waitForIdle");

                if (!needsAsync) {
                    auto resp = inst->handleCommand(req);
                    return facebook::jsi::String::createFromUtf8(rt, resp.toJSON());
                }

                // Async path. Background worker → JS-thread callback
                // writes into `globalThis.__ennioResults[token]`. CLI
                // polls.
                std::thread([inst, req, token, exec]() {
                    auto resp = inst->handleCommand(req);
                    std::string json = resp.toJSON();
                    exec([token, json](facebook::jsi::Runtime& rt2) {
                        try {
                            auto results = rt2.global().getProperty(rt2, "__ennioResults");
                            if (!results.isObject()) {
                                auto fresh = facebook::jsi::Object(rt2);
                                rt2.global().setProperty(rt2, "__ennioResults", fresh);
                                results = rt2.global().getProperty(rt2, "__ennioResults");
                            }
                            results.asObject(rt2).setProperty(
                                rt2,
                                token.c_str(),
                                facebook::jsi::String::createFromUtf8(rt2, json));
                        } catch (...) {
                            /* runtime gone — orphan token, CLI times out. */
                        }
                    });
                }).detach();

                return facebook::jsi::Value::undefined();
            });
        runtime.global().setProperty(runtime, "__ennioDispatch", dispatchFn);
    } catch (const std::exception& e) {
        ENNIO_LOG_TRACE(LOG_TAG, ENNIO_LOG_FMT("nativeBootstrap: __ennioDispatch install failed: " << e.what()));
    }
}

} // namespace margelo::nitro::ennio
