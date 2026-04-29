#pragma once

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include <react/renderer/core/ShadowNode.h>

namespace tasto {

/**
 * TestIDRegistry provides O(1) lookup of ShadowNodes by testID.
 *
 * This class maintains a hashmap from testID strings to weak pointers
 * of ShadowNodes. The registry is updated on shadow tree commits and
 * falls back to tree traversal if a cached entry is stale.
 */
class TestIDRegistry {
public:
    using ShadowNodePtr = std::shared_ptr<const facebook::react::ShadowNode>;
    using WeakShadowNodePtr = std::weak_ptr<const facebook::react::ShadowNode>;

    static TestIDRegistry& getInstance();

    // Prevent copying
    TestIDRegistry(const TestIDRegistry&) = delete;
    TestIDRegistry& operator=(const TestIDRegistry&) = delete;

    /**
     * Register a ShadowNode with a testID
     */
    void registerNode(const std::string& testID, ShadowNodePtr node);

    /**
     * Remove a testID from the registry
     */
    void unregisterNode(const std::string& testID);

    /**
     * Look up a ShadowNode by testID
     * Returns nullptr if not found or if the weak_ptr is expired
     */
    ShadowNodePtr findByTestID(const std::string& testID) const;

    /**
     * Check if a testID exists in the registry
     */
    bool exists(const std::string& testID) const;

    /**
     * Clear all registered nodes
     */
    void clear();

    /**
     * Get the number of registered testIDs
     */
    size_t size() const;

    /**
     * Update registry from a shadow tree root
     * Traverses the tree and updates all testID mappings
     */
    void updateFromTree(ShadowNodePtr root);

private:
    TestIDRegistry() = default;

    mutable std::mutex mutex_;
    std::unordered_map<std::string, WeakShadowNodePtr> registry_;

    /**
     * Recursively traverse and register nodes with testIDs
     */
    void traverseAndRegister(const facebook::react::ShadowNode& node);
};

} // namespace tasto
