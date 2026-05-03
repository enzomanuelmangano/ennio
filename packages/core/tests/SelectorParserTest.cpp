/**
 * SelectorParser Unit Tests
 *
 * Tests the JSON selector parsing functionality used by Maestro YAML commands.
 */

#include <gtest/gtest.h>
#include "SelectorParser.hpp"

namespace ennio {
namespace {

// ============================================
// Basic Parsing Tests
// ============================================

TEST(SelectorParserTest, ParsePlainString) {
    auto criteria = SelectorParser::parse("my-test-id");
    ASSERT_TRUE(criteria.id.has_value());
    EXPECT_EQ(criteria.id.value(), "my-test-id");
    EXPECT_FALSE(criteria.text.has_value());
    EXPECT_TRUE(criteria.isIdOnly());
}

TEST(SelectorParserTest, ParseQuotedString) {
    auto criteria = SelectorParser::parse("\"btn-login\"");
    ASSERT_TRUE(criteria.id.has_value());
    EXPECT_EQ(criteria.id.value(), "btn-login");
    EXPECT_TRUE(criteria.isIdOnly());
}

TEST(SelectorParserTest, ParseIdOnlyObject) {
    auto criteria = SelectorParser::parse(R"({"id":"submit-btn"})");
    ASSERT_TRUE(criteria.id.has_value());
    EXPECT_EQ(criteria.id.value(), "submit-btn");
    EXPECT_FALSE(criteria.text.has_value());
    EXPECT_TRUE(criteria.isIdOnly());
}

TEST(SelectorParserTest, ParseEmptyThrows) {
    EXPECT_THROW(SelectorParser::parse(""), std::runtime_error);
    EXPECT_THROW(SelectorParser::parse("   "), std::runtime_error);
}

// ============================================
// Text Matching Tests
// ============================================

TEST(SelectorParserTest, ParseTextExact) {
    auto criteria = SelectorParser::parse(R"({"text":"Login"})");
    ASSERT_TRUE(criteria.text.has_value());
    EXPECT_EQ(criteria.text->pattern, "Login");
    EXPECT_EQ(criteria.text->mode, TextMatchMode::Exact);
    EXPECT_FALSE(criteria.isIdOnly());
}

TEST(SelectorParserTest, ParseTextContains) {
    auto criteria = SelectorParser::parse(R"({"text":"Login","textMatchMode":"contains"})");
    ASSERT_TRUE(criteria.text.has_value());
    EXPECT_EQ(criteria.text->pattern, "Login");
    EXPECT_EQ(criteria.text->mode, TextMatchMode::Contains);
}

TEST(SelectorParserTest, ParseTextRegex) {
    auto criteria = SelectorParser::parse(R"({"text":".*Submit.*","textMatchMode":"regex"})");
    ASSERT_TRUE(criteria.text.has_value());
    EXPECT_EQ(criteria.text->pattern, ".*Submit.*");
    EXPECT_EQ(criteria.text->mode, TextMatchMode::Regex);
}

TEST(SelectorParserTest, ParseTextStartsWith) {
    auto criteria = SelectorParser::parse(R"({"text":"Welcome","textMatchMode":"startsWith"})");
    ASSERT_TRUE(criteria.text.has_value());
    EXPECT_EQ(criteria.text->pattern, "Welcome");
    EXPECT_EQ(criteria.text->mode, TextMatchMode::StartsWith);
}

TEST(SelectorParserTest, ParseTextEndsWith) {
    auto criteria = SelectorParser::parse(R"({"text":"Button","textMatchMode":"endsWith"})");
    ASSERT_TRUE(criteria.text.has_value());
    EXPECT_EQ(criteria.text->pattern, "Button");
    EXPECT_EQ(criteria.text->mode, TextMatchMode::EndsWith);
}

TEST(SelectorParserTest, ParseTextWithEscapedQuotes) {
    auto criteria = SelectorParser::parse(R"({"text":"Say \"Hello\""})");
    ASSERT_TRUE(criteria.text.has_value());
    EXPECT_EQ(criteria.text->pattern, "Say \"Hello\"");
}

// ============================================
// Combined Selectors Tests
// ============================================

TEST(SelectorParserTest, ParseIdAndText) {
    auto criteria = SelectorParser::parse(R"({"id":"btn-1","text":"Click Me"})");
    ASSERT_TRUE(criteria.id.has_value());
    ASSERT_TRUE(criteria.text.has_value());
    EXPECT_EQ(criteria.id.value(), "btn-1");
    EXPECT_EQ(criteria.text->pattern, "Click Me");
    EXPECT_FALSE(criteria.isIdOnly());
}

TEST(SelectorParserTest, ParseWithIndex) {
    auto criteria = SelectorParser::parse(R"({"text":"Item","index":2})");
    ASSERT_TRUE(criteria.text.has_value());
    ASSERT_TRUE(criteria.index.has_value());
    EXPECT_EQ(criteria.index.value(), 2);
}

// ============================================
// State Selector Tests
// ============================================

TEST(SelectorParserTest, ParseEnabled) {
    auto criteria = SelectorParser::parse(R"({"id":"btn","enabled":true})");
    ASSERT_TRUE(criteria.enabled.has_value());
    EXPECT_TRUE(criteria.enabled.value());
}

TEST(SelectorParserTest, ParseDisabled) {
    auto criteria = SelectorParser::parse(R"({"id":"btn","enabled":false})");
    ASSERT_TRUE(criteria.enabled.has_value());
    EXPECT_FALSE(criteria.enabled.value());
}

TEST(SelectorParserTest, ParseChecked) {
    auto criteria = SelectorParser::parse(R"({"id":"checkbox","checked":true})");
    ASSERT_TRUE(criteria.checked.has_value());
    EXPECT_TRUE(criteria.checked.value());
}

TEST(SelectorParserTest, ParseFocused) {
    auto criteria = SelectorParser::parse(R"({"id":"input","focused":true})");
    ASSERT_TRUE(criteria.focused.has_value());
    EXPECT_TRUE(criteria.focused.value());
}

TEST(SelectorParserTest, ParseSelected) {
    auto criteria = SelectorParser::parse(R"({"id":"tab","selected":true})");
    ASSERT_TRUE(criteria.selected.has_value());
    EXPECT_TRUE(criteria.selected.value());
}

// ============================================
// Spatial Selector Tests
// ============================================

TEST(SelectorParserTest, ParseBelow) {
    auto criteria = SelectorParser::parse(R"({
        "text": "Submit",
        "below": {"id": "header"}
    })");
    ASSERT_TRUE(criteria.text.has_value());
    ASSERT_TRUE(criteria.below != nullptr);
    EXPECT_TRUE(criteria.below->id.has_value());
    EXPECT_EQ(criteria.below->id.value(), "header");
    EXPECT_TRUE(criteria.hasSpatialCriteria());
}

TEST(SelectorParserTest, ParseAbove) {
    auto criteria = SelectorParser::parse(R"({
        "text": "Footer",
        "above": {"id": "content"}
    })");
    ASSERT_TRUE(criteria.above != nullptr);
    EXPECT_EQ(criteria.above->id.value(), "content");
}

TEST(SelectorParserTest, ParseLeftOf) {
    auto criteria = SelectorParser::parse(R"({
        "id": "price",
        "leftOf": {"text": "Add to Cart"}
    })");
    ASSERT_TRUE(criteria.leftOf != nullptr);
    EXPECT_EQ(criteria.leftOf->text->pattern, "Add to Cart");
}

TEST(SelectorParserTest, ParseRightOf) {
    auto criteria = SelectorParser::parse(R"({
        "text": "Quantity",
        "rightOf": {"id": "product-image"}
    })");
    ASSERT_TRUE(criteria.rightOf != nullptr);
    EXPECT_EQ(criteria.rightOf->id.value(), "product-image");
}

// ============================================
// Hierarchical Selector Tests
// ============================================

TEST(SelectorParserTest, ParseContainsChild) {
    auto criteria = SelectorParser::parse(R"({
        "id": "card",
        "containsChild": {"text": "Title"}
    })");
    ASSERT_TRUE(criteria.containsChild != nullptr);
    EXPECT_EQ(criteria.containsChild->text->pattern, "Title");
    EXPECT_TRUE(criteria.hasHierarchicalCriteria());
}

TEST(SelectorParserTest, ParseChildOf) {
    auto criteria = SelectorParser::parse(R"({
        "text": "OK",
        "childOf": {"id": "modal"}
    })");
    ASSERT_TRUE(criteria.childOf != nullptr);
    EXPECT_EQ(criteria.childOf->id.value(), "modal");
}

TEST(SelectorParserTest, ParseContainsDescendants) {
    auto criteria = SelectorParser::parse(R"({
        "id": "list",
        "containsDescendants": [
            {"text": "Item 1"},
            {"text": "Item 2"}
        ]
    })");
    EXPECT_EQ(criteria.containsDescendants.size(), 2);
    EXPECT_EQ(criteria.containsDescendants[0]->text->pattern, "Item 1");
    EXPECT_EQ(criteria.containsDescendants[1]->text->pattern, "Item 2");
}

// ============================================
// Dimension Selector Tests
// ============================================

TEST(SelectorParserTest, ParseDimensions) {
    auto criteria = SelectorParser::parse(R"({
        "id": "image",
        "width": 100,
        "height": 100,
        "tolerance": 5
    })");
    ASSERT_TRUE(criteria.width.has_value());
    ASSERT_TRUE(criteria.height.has_value());
    ASSERT_TRUE(criteria.tolerance.has_value());
    EXPECT_FLOAT_EQ(criteria.width.value(), 100.0f);
    EXPECT_FLOAT_EQ(criteria.height.value(), 100.0f);
    EXPECT_FLOAT_EQ(criteria.tolerance.value(), 5.0f);
    EXPECT_TRUE(criteria.hasDimensionCriteria());
}

// ============================================
// Point Selector Tests
// ============================================

TEST(SelectorParserTest, ParsePointAbsolute) {
    auto criteria = SelectorParser::parse(R"({"point":"150,200"})");
    ASSERT_TRUE(criteria.point.has_value());
    EXPECT_FLOAT_EQ(criteria.point->x, 150.0f);
    EXPECT_FLOAT_EQ(criteria.point->y, 200.0f);
    EXPECT_FALSE(criteria.point->isPercentage);
}

TEST(SelectorParserTest, ParsePointPercentage) {
    auto criteria = SelectorParser::parse(R"({"point":"50%,75%"})");
    ASSERT_TRUE(criteria.point.has_value());
    EXPECT_FLOAT_EQ(criteria.point->x, 50.0f);
    EXPECT_FLOAT_EQ(criteria.point->y, 75.0f);
    EXPECT_TRUE(criteria.point->isPercentage);
}

// ============================================
// Trait Selector Tests
// ============================================

TEST(SelectorParserTest, ParseTraits) {
    auto criteria = SelectorParser::parse(R"({
        "id": "paragraph",
        "traits": ["long-text"]
    })");
    EXPECT_EQ(criteria.traits.size(), 1);
    EXPECT_EQ(criteria.traits[0], Trait::LongText);
}

TEST(SelectorParserTest, ParseMultipleTraits) {
    auto criteria = SelectorParser::parse(R"({
        "id": "avatar",
        "traits": ["square", "text"]
    })");
    EXPECT_EQ(criteria.traits.size(), 2);
    EXPECT_EQ(criteria.traits[0], Trait::Square);
    EXPECT_EQ(criteria.traits[1], Trait::Text);
}

// ============================================
// Serialization Tests (toJSON)
// ============================================

TEST(SelectorParserTest, ToJsonIdOnly) {
    SelectorCriteria criteria;
    criteria.id = "test-id";
    auto json = SelectorParser::toJSON(criteria);
    EXPECT_EQ(json, R"({"id":"test-id"})");
}

TEST(SelectorParserTest, ToJsonWithText) {
    SelectorCriteria criteria;
    criteria.text = TextMatcher{"Hello", TextMatchMode::Contains};
    auto json = SelectorParser::toJSON(criteria);
    EXPECT_EQ(json, R"({"text":"Hello","textMatchMode":"contains"})");
}

TEST(SelectorParserTest, ToJsonRoundTrip) {
    auto original = R"({"id":"btn","text":"Click","enabled":true})";
    auto criteria = SelectorParser::parse(original);
    auto serialized = SelectorParser::toJSON(criteria);
    auto reparsed = SelectorParser::parse(serialized);

    EXPECT_EQ(criteria.id, reparsed.id);
    EXPECT_EQ(criteria.text->pattern, reparsed.text->pattern);
    EXPECT_EQ(criteria.enabled, reparsed.enabled);
}

// ============================================
// Helper Method Tests
// ============================================

TEST(SelectorCriteriaTest, FromIdFactory) {
    auto criteria = SelectorCriteria::fromId("my-button");
    EXPECT_EQ(criteria.id.value(), "my-button");
    EXPECT_TRUE(criteria.isIdOnly());
}

TEST(SelectorCriteriaTest, FromTextFactory) {
    auto criteria = SelectorCriteria::fromText("Welcome", TextMatchMode::Contains);
    EXPECT_EQ(criteria.text->pattern, "Welcome");
    EXPECT_EQ(criteria.text->mode, TextMatchMode::Contains);
    EXPECT_FALSE(criteria.isIdOnly());
}

} // namespace
} // namespace ennio
