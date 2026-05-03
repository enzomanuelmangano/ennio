#include "TestIDRegistry.hpp"

#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/LayoutableShadowNode.h>

namespace ennio {

TestIDRegistry& TestIDRegistry::getInstance() {
    static TestIDRegistry instance;
    return instance;
}

void TestIDRegistry::registerNode(const std::string& testID, ShadowNodePtr node) {
    if (testID.empty() || !node) {
        return;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    registry_[testID] = node;
}

void TestIDRegistry::unregisterNode(const std::string& testID) {
    std::lock_guard<std::mutex> lock(mutex_);
    registry_.erase(testID);
}

TestIDRegistry::ShadowNodePtr TestIDRegistry::findByTestID(const std::string& testID) const {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = registry_.find(testID);
    if (it == registry_.end()) {
        return nullptr;
    }

    // Try to lock the weak pointer
    auto node = it->second.lock();
    if (!node) {
        // Entry is stale, but we can't modify in const method
        // The caller should trigger a tree update
        return nullptr;
    }

    return node;
}

bool TestIDRegistry::exists(const std::string& testID) const {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = registry_.find(testID);
    if (it == registry_.end()) {
        return false;
    }

    // Check if weak_ptr is still valid
    return !it->second.expired();
}

void TestIDRegistry::clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    registry_.clear();
}

size_t TestIDRegistry::size() const {
    std::lock_guard<std::mutex> lock(mutex_);

    // Count only non-expired entries
    size_t count = 0;
    for (const auto& pair : registry_) {
        if (!pair.second.expired()) {
            count++;
        }
    }
    return count;
}

void TestIDRegistry::updateFromTree(ShadowNodePtr root) {
    if (!root) {
        return;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    registry_.clear();

    traverseAndRegister(root);
}

void TestIDRegistry::traverseAndRegister(ShadowNodePtr node) {
    if (!node) {
        return;
    }

    // Try to get testID from ViewProps
    auto viewProps = std::dynamic_pointer_cast<const facebook::react::ViewProps>(
        node->getProps()
    );

    if (viewProps && !viewProps->testId.empty()) {
        // Store the shared_ptr as weak_ptr for O(1) lookup
        registry_[viewProps->testId] = node;
    }

    // Recursively traverse children (getChildren() returns shared_ptr)
    for (const auto& child : node->getChildren()) {
        traverseAndRegister(child);
    }
}

} // namespace ennio
