/**
 * ElementMatcher Unit Tests
 *
 * Tests the element matching logic used for selector-based queries.
 *
 * NOTE: These tests require mocks for React Native ShadowNode types.
 * Full testing requires the React Native build environment.
 * Currently only tests that don't require ShadowNode are included.
 */

#include <gtest/gtest.h>
#include "SelectorCriteria.hpp"

namespace tasto {
namespace {

// ============================================
// TextMatcher Tests
// ============================================

TEST(TextMatcherTest, MatchExact) {
    TextMatcher matcher{"Hello", TextMatchMode::Exact};
    EXPECT_TRUE(matcher.matches("Hello"));
    EXPECT_FALSE(matcher.matches("hello"));
    EXPECT_FALSE(matcher.matches("Hello World"));
    EXPECT_FALSE(matcher.matches(""));
}

TEST(TextMatcherTest, MatchContains) {
    TextMatcher matcher{"ello", TextMatchMode::Contains};
    EXPECT_TRUE(matcher.matches("Hello"));
    EXPECT_TRUE(matcher.matches("Yellow"));
    EXPECT_TRUE(matcher.matches("xelloY"));
    EXPECT_FALSE(matcher.matches("Halo"));
}

TEST(TextMatcherTest, MatchStartsWith) {
    TextMatcher matcher{"Hello", TextMatchMode::StartsWith};
    EXPECT_TRUE(matcher.matches("Hello"));
    EXPECT_TRUE(matcher.matches("Hello World"));
    EXPECT_FALSE(matcher.matches("Say Hello"));
    EXPECT_FALSE(matcher.matches("hello"));
}

TEST(TextMatcherTest, MatchEndsWith) {
    TextMatcher matcher{"World", TextMatchMode::EndsWith};
    EXPECT_TRUE(matcher.matches("World"));
    EXPECT_TRUE(matcher.matches("Hello World"));
    EXPECT_FALSE(matcher.matches("World!"));
    EXPECT_FALSE(matcher.matches("world"));
}

TEST(TextMatcherTest, MatchRegex) {
    TextMatcher matcher{"^[A-Z][a-z]+$", TextMatchMode::Regex};
    EXPECT_TRUE(matcher.matches("Hello"));
    EXPECT_TRUE(matcher.matches("World"));
    EXPECT_FALSE(matcher.matches("hello"));
    EXPECT_FALSE(matcher.matches("HELLO"));
    EXPECT_FALSE(matcher.matches("Hello World"));
}

TEST(TextMatcherTest, MatchRegexSpecialChars) {
    TextMatcher matcher{"\\d{3}-\\d{4}", TextMatchMode::Regex};
    EXPECT_TRUE(matcher.matches("123-4567"));
    EXPECT_TRUE(matcher.matches("xxx 987-6543 yyy"));
    EXPECT_FALSE(matcher.matches("12-3456"));
}

// ============================================
// SelectorCriteria Helper Tests
// ============================================

TEST(SelectorCriteriaTest, IsIdOnlyWithIdOnly) {
    SelectorCriteria criteria;
    criteria.id = "test-id";
    EXPECT_TRUE(criteria.isIdOnly());
}

TEST(SelectorCriteriaTest, IsIdOnlyWithIdAndText) {
    SelectorCriteria criteria;
    criteria.id = "test-id";
    criteria.text = TextMatcher{"Text", TextMatchMode::Exact};
    EXPECT_FALSE(criteria.isIdOnly());
}

TEST(SelectorCriteriaTest, HasSpatialCriteriaFalse) {
    SelectorCriteria criteria;
    criteria.id = "test-id";
    EXPECT_FALSE(criteria.hasSpatialCriteria());
}

TEST(SelectorCriteriaTest, HasSpatialCriteriaWithBelow) {
    SelectorCriteria criteria;
    criteria.id = "test-id";
    criteria.below = std::make_shared<SelectorCriteria>();
    criteria.below->id = "anchor";
    EXPECT_TRUE(criteria.hasSpatialCriteria());
}

TEST(SelectorCriteriaTest, HasDimensionCriteriaFalse) {
    SelectorCriteria criteria;
    criteria.id = "test-id";
    EXPECT_FALSE(criteria.hasDimensionCriteria());
}

TEST(SelectorCriteriaTest, HasDimensionCriteriaWithWidth) {
    SelectorCriteria criteria;
    criteria.id = "test-id";
    criteria.width = 100.0f;
    EXPECT_TRUE(criteria.hasDimensionCriteria());
}

// ============================================
// NOTE: Full ElementMatcher tests require ShadowNode mocks
// These would test findFirst, findAll, matchesCriteria, etc.
// For now, only text matching and criteria helper tests are included.
// ============================================

} // namespace
} // namespace tasto
