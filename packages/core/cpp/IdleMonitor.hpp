#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>

namespace ennio {

/**
 * IdleMonitor tracks pending work to determine when the UI is idle.
 *
 * It monitors:
 * - Shadow tree commits/mounts
 * - JS thread tasks
 * - Network requests (optional)
 *
 * This is a singleton that can be accessed from anywhere in the app.
 */
class IdleMonitor {
public:
    static IdleMonitor& getInstance() {
        static IdleMonitor instance;
        return instance;
    }

    // Prevent copying
    IdleMonitor(const IdleMonitor&) = delete;
    IdleMonitor& operator=(const IdleMonitor&) = delete;

    // ============================================
    // Shadow Tree Tracking
    // ============================================

    /**
     * Called when a shadow tree commit starts
     */
    void onShadowTreeCommitStart() {
        pendingCommits_.fetch_add(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
    }

    /**
     * Called when a shadow tree commit completes
     */
    void onShadowTreeCommitEnd() {
        pendingCommits_.fetch_sub(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
        checkAndNotify();
    }

    /**
     * Called when a shadow tree mount starts
     */
    void onShadowTreeMountStart() {
        pendingMounts_.fetch_add(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
    }

    /**
     * Called when a shadow tree mount completes
     */
    void onShadowTreeMountEnd() {
        pendingMounts_.fetch_sub(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
        checkAndNotify();
    }

    // ============================================
    // JS Thread Tracking
    // ============================================

    /**
     * Called when a JS task starts
     */
    void onJSTaskStart() {
        pendingJSTasks_.fetch_add(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
    }

    /**
     * Called when a JS task completes
     */
    void onJSTaskEnd() {
        pendingJSTasks_.fetch_sub(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
        checkAndNotify();
    }

    // ============================================
    // Network Request Tracking (optional)
    // ============================================

    /**
     * Called when a network request starts
     */
    void onNetworkRequestStart() {
        pendingNetworkRequests_.fetch_add(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
    }

    /**
     * Called when a network request completes
     */
    void onNetworkRequestEnd() {
        pendingNetworkRequests_.fetch_sub(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
        checkAndNotify();
    }

    // ============================================
    // Animation Tracking
    // ============================================

    /**
     * Called when an animation starts
     */
    void onAnimationStart() {
        pendingAnimations_.fetch_add(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
    }

    /**
     * Called when an animation completes
     */
    void onAnimationEnd() {
        pendingAnimations_.fetch_sub(1);
        lastActivityTime_ = std::chrono::steady_clock::now();
        checkAndNotify();
    }

    // ============================================
    // Status Queries
    // ============================================

    /**
     * Check if the UI is currently idle
     * Returns true if:
     * - No pending commits or mounts
     * - No pending JS tasks
     * - (Optionally) No pending network requests
     * - (Optionally) No pending animations
     */
    bool isIdle(bool includeNetwork = false, bool includeAnimations = false) const {
        if (pendingCommits_.load() > 0) return false;
        if (pendingMounts_.load() > 0) return false;
        if (pendingJSTasks_.load() > 0) return false;
        if (includeNetwork && pendingNetworkRequests_.load() > 0) return false;
        if (includeAnimations && pendingAnimations_.load() > 0) return false;
        return true;
    }

    /**
     * Get the time since the last activity
     */
    std::chrono::milliseconds timeSinceLastActivity() const {
        auto now = std::chrono::steady_clock::now();
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            now - lastActivityTime_.load()
        );
    }

    /**
     * Wait for idle state with timeout
     * @param timeoutMs Maximum time to wait in milliseconds
     * @param includeNetwork Whether to wait for network requests
     * @param includeAnimations Whether to wait for animations
     * @param stabilityMs How long the system must be idle before returning
     * @return true if idle state was reached, false on timeout
     */
    bool waitForIdle(
        int timeoutMs,
        bool includeNetwork = false,
        bool includeAnimations = false,
        int stabilityMs = 100
    ) {
        auto deadline = std::chrono::steady_clock::now() +
            std::chrono::milliseconds(timeoutMs);

        std::unique_lock<std::mutex> lock(mutex_);

        while (std::chrono::steady_clock::now() < deadline) {
            // Check if idle
            if (isIdle(includeNetwork, includeAnimations)) {
                // Check stability - has it been idle long enough?
                auto idleTime = timeSinceLastActivity();
                if (idleTime.count() >= stabilityMs) {
                    return true;
                }

                // Wait for remaining stability time
                auto remainingStability = std::chrono::milliseconds(stabilityMs) - idleTime;
                cv_.wait_for(lock, remainingStability);
            } else {
                // Wait for notification or timeout
                auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                    deadline - std::chrono::steady_clock::now()
                );
                if (remaining.count() <= 0) {
                    return false;
                }
                cv_.wait_for(lock, remaining);
            }
        }

        return isIdle(includeNetwork, includeAnimations);
    }

    // ============================================
    // Debug Information
    // ============================================

    /**
     * Get current pending counts for debugging
     */
    struct PendingCounts {
        int commits;
        int mounts;
        int jsTasks;
        int networkRequests;
        int animations;
    };

    PendingCounts getPendingCounts() const {
        return {
            pendingCommits_.load(),
            pendingMounts_.load(),
            pendingJSTasks_.load(),
            pendingNetworkRequests_.load(),
            pendingAnimations_.load()
        };
    }

    /**
     * Reset all counters (for testing)
     */
    void reset() {
        pendingCommits_.store(0);
        pendingMounts_.store(0);
        pendingJSTasks_.store(0);
        pendingNetworkRequests_.store(0);
        pendingAnimations_.store(0);
        lastActivityTime_.store(std::chrono::steady_clock::now());
    }

private:
    IdleMonitor()
        : pendingCommits_(0)
        , pendingMounts_(0)
        , pendingJSTasks_(0)
        , pendingNetworkRequests_(0)
        , pendingAnimations_(0)
        , lastActivityTime_(std::chrono::steady_clock::now()) {}

    void checkAndNotify() {
        if (isIdle()) {
            cv_.notify_all();
        }
    }

    // Atomic counters for thread-safe tracking
    std::atomic<int> pendingCommits_;
    std::atomic<int> pendingMounts_;
    std::atomic<int> pendingJSTasks_;
    std::atomic<int> pendingNetworkRequests_;
    std::atomic<int> pendingAnimations_;

    // Last activity timestamp
    std::atomic<std::chrono::steady_clock::time_point> lastActivityTime_;

    // Mutex and condition variable for waiting
    mutable std::mutex mutex_;
    std::condition_variable cv_;
};

} // namespace ennio
