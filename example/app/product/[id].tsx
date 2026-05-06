import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  Alert,
  Pressable,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useProductsStore,
  useCartStore,
  useSettingsStore,
} from '../../store';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { colors, fontSize, lineHeight, radius } from '../../src/theme';

type Palette = ReturnType<typeof colors>;

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const products = useProductsStore(state => state.products);
  const addToCart = useCartStore(state => state.addToCart);
  const cartItems = useCartStore(state => state.items);
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);
  const insets = useSafeAreaInsets();

  const [quantity, setQuantity] = useState(1);
  const [selectedTab, setSelectedTab] = useState<
    'description' | 'specs' | 'reviews'
  >('description');

  const product = products.find(p => p.id === id);
  const inCart = cartItems.find(item => item.product.id === id);

  if (!product) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: c.systemGroupedBackground,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={[styles.errorText, { color: c.label }]}>
          Product not found
        </Text>
        <PressableScale
          style={[styles.backButton, { backgroundColor: c.systemBlue }]}
          onPress={() => router.back()}
        >
          <Text style={styles.backButtonText}>Go Back</Text>
        </PressableScale>
      </View>
    );
  }

  const handleAddToCart = () => {
    if (!product.inStock) {
      Alert.alert('Out of Stock', 'This product is currently unavailable.');
      return;
    }
    addToCart(product, quantity);
    if (hapticEnabled) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    Alert.alert(
      'Added to Cart',
      `${quantity}x ${product.name} added to your cart.`,
      [
        { text: 'Continue Shopping', style: 'cancel' },
        {
          text: 'View Cart',
          onPress: () => {
            router.dismissAll();
            router.push('/cart');
          },
        },
      ],
    );
  };

  const handleQuantityChange = (delta: number) => {
    const newQty = Math.max(1, Math.min(10, quantity + delta));
    setQuantity(newQty);
    if (hapticEnabled && newQty !== quantity) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: product.name,
          headerStyle: { backgroundColor: c.systemBackground },
          headerTintColor: c.label,
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.systemGroupedBackground }}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        testID="product-detail-screen"
      >
        <View style={styles.imageWrap}>
          <Image source={{ uri: product.image }} style={styles.productImage} />
          {!product.inStock && (
            <View style={styles.outOfStockBanner}>
              <Text style={styles.outOfStockText}>Out of Stock</Text>
            </View>
          )}
        </View>

        <View style={styles.content}>
          <View style={styles.headerRow}>
            <Text style={[styles.category, { color: c.secondaryLabel }]}>
              {product.category}
            </Text>
            <View
              style={[
                styles.ratingBadge,
                { backgroundColor: c.systemYellow + '33' },
              ]}
            >
              <Text style={[styles.ratingGlyph, { color: c.systemOrange }]}>
                ★
              </Text>
              <Text style={[styles.ratingText, { color: c.label }]}>
                {product.rating}
              </Text>
            </View>
          </View>

          <Text
            style={[styles.title, { color: c.label }]}
            testID="product-title"
          >
            {product.name}
          </Text>

          <View style={styles.priceRow}>
            <Text
              style={[styles.price, { color: c.label }]}
              testID="product-price"
            >
              ${product.price.toFixed(2)}
            </Text>
            <Text style={[styles.reviews, { color: c.secondaryLabel }]}>
              {product.reviews} reviews
            </Text>
          </View>

          {/* Quantity card */}
          <View
            style={[
              styles.card,
              { backgroundColor: c.secondarySystemGroupedBackground },
            ]}
          >
            <Text style={[styles.cardLabel, { color: c.label }]}>
              Quantity
            </Text>
            <View
              style={[
                styles.stepper,
                { backgroundColor: c.tertiarySystemFill },
              ]}
            >
              <Pressable
                style={styles.stepperBtn}
                onPress={() => handleQuantityChange(-1)}
                testID="decrease-quantity"
                hitSlop={4}
              >
                <Text style={[styles.stepperGlyph, { color: c.label }]}>
                  −
                </Text>
              </Pressable>
              <Text
                style={[styles.quantityValue, { color: c.label }]}
                testID="quantity-value"
              >
                {quantity}
              </Text>
              <Pressable
                style={styles.stepperBtn}
                onPress={() => handleQuantityChange(1)}
                testID="increase-quantity"
                hitSlop={4}
              >
                <Text style={[styles.stepperGlyph, { color: c.label }]}>
                  +
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Segmented control */}
          <View
            style={[
              styles.segmented,
              { backgroundColor: c.tertiarySystemFill },
            ]}
          >
            {(['description', 'specs', 'reviews'] as const).map(tab => {
              const active = selectedTab === tab;
              return (
                <PressableScale
                  key={tab}
                  style={StyleSheet.flatten([
                    styles.segment,
                    active && {
                      backgroundColor: c.secondarySystemGroupedBackground,
                    },
                  ])}
                  onPress={() => setSelectedTab(tab)}
                  testID={`tab-${tab}`}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      {
                        color: active ? c.label : c.secondaryLabel,
                        fontWeight: active ? '600' : '500',
                      },
                    ]}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </Text>
                </PressableScale>
              );
            })}
          </View>

          {/* Tab content card */}
          <View
            style={[
              styles.card,
              { backgroundColor: c.secondarySystemGroupedBackground },
            ]}
          >
            {selectedTab === 'description' && (
              <Text
                style={[styles.description, { color: c.label }]}
                testID="product-description"
              >
                {product.description}
              </Text>
            )}
            {selectedTab === 'specs' && (
              <View testID="product-specs">
                <SpecRow
                  label="Category"
                  value={product.category}
                  c={c}
                  isLast={false}
                />
                <SpecRow
                  label="Rating"
                  value={`${product.rating} / 5.0`}
                  c={c}
                  isLast={false}
                />
                <SpecRow
                  label="Reviews"
                  value={`${product.reviews} reviews`}
                  c={c}
                  isLast={false}
                />
                <SpecRow
                  label="Availability"
                  value={product.inStock ? 'In Stock' : 'Out of Stock'}
                  c={c}
                  isLast={false}
                />
                <SpecRow
                  label="SKU"
                  value={`SKU-${product.id.toUpperCase()}`}
                  c={c}
                  isLast={true}
                />
              </View>
            )}
            {selectedTab === 'reviews' && (
              <View testID="product-reviews">
                <ReviewCard
                  name="John D."
                  rating={5}
                  comment="Excellent product! Highly recommended."
                  date="2 days ago"
                  c={c}
                  isLast={false}
                />
                <ReviewCard
                  name="Sarah M."
                  rating={4}
                  comment="Great quality, fast shipping."
                  date="1 week ago"
                  c={c}
                  isLast={false}
                />
                <ReviewCard
                  name="Mike T."
                  rating={5}
                  comment="Exactly as described. Very happy with my purchase."
                  date="2 weeks ago"
                  c={c}
                  isLast={true}
                />
              </View>
            )}
          </View>

          {inCart && (
            <View
              style={[
                styles.inCartBadge,
                { backgroundColor: c.systemGreen + '22' },
              ]}
            >
              <Text style={[styles.inCartText, { color: c.systemGreen }]}>
                ✓ {inCart.quantity} already in cart
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Fixed Bottom Bar */}
      <View
        style={[
          styles.bottomBar,
          {
            backgroundColor: c.secondarySystemGroupedBackground,
            borderTopColor: c.separator,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <View style={styles.bottomPriceContainer}>
          <Text
            style={[styles.bottomPriceLabel, { color: c.secondaryLabel }]}
          >
            Total
          </Text>
          <Text style={[styles.bottomPrice, { color: c.label }]}>
            ${(product.price * quantity).toFixed(2)}
          </Text>
        </View>
        <PressableScale
          style={StyleSheet.flatten([
            styles.addToCartButton,
            { backgroundColor: c.systemBlue },
            !product.inStock && { backgroundColor: c.tertiarySystemFill },
          ])}
          onPress={handleAddToCart}
          enabled={product.inStock}
          testID="add-to-cart-btn"
        >
          <Text style={styles.addToCartText}>
            {product.inStock ? 'Add to Cart' : 'Out of Stock'}
          </Text>
        </PressableScale>
      </View>
    </>
  );
}

function SpecRow({
  label,
  value,
  c,
  isLast,
}: {
  label: string;
  value: string;
  c: Palette;
  isLast: boolean;
}) {
  return (
    <View
      style={[
        styles.specRow,
        !isLast && {
          borderBottomColor: c.separator,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      <Text style={[styles.specLabel, { color: c.secondaryLabel }]}>
        {label}
      </Text>
      <Text style={[styles.specValue, { color: c.label }]}>{value}</Text>
    </View>
  );
}

function ReviewCard({
  name,
  rating,
  comment,
  date,
  c,
  isLast,
}: {
  name: string;
  rating: number;
  comment: string;
  date: string;
  c: Palette;
  isLast: boolean;
}) {
  return (
    <View
      style={[
        styles.reviewCard,
        !isLast && {
          borderBottomColor: c.separator,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      <View style={styles.reviewHeader}>
        <Text style={[styles.reviewerName, { color: c.label }]}>{name}</Text>
        <Text style={[styles.reviewRating, { color: c.systemOrange }]}>
          {'★'.repeat(rating)}
        </Text>
      </View>
      <Text style={[styles.reviewComment, { color: c.label }]}>{comment}</Text>
      <Text style={[styles.reviewDate, { color: c.secondaryLabel }]}>
        {date}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  errorText: {
    fontSize: fontSize.body,
    marginBottom: 20,
  },
  backButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: radius.button,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  imageWrap: {
    width: '100%',
    aspectRatio: 1.1,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  productImage: {
    width: '100%',
    height: '100%',
  },
  outOfStockBanner: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 10,
    alignItems: 'center',
  },
  outOfStockText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: fontSize.subhead,
  },
  content: {
    padding: 20,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  category: {
    fontSize: fontSize.footnote,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight: '600',
  },
  ratingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  ratingGlyph: {
    fontSize: 13,
    marginRight: 4,
  },
  ratingText: {
    fontSize: fontSize.subhead,
    fontWeight: '700',
  },
  title: {
    fontSize: fontSize.title1,
    lineHeight: lineHeight.title1,
    fontWeight: '700',
    marginBottom: 10,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  price: {
    fontSize: fontSize.title1,
    fontWeight: '700',
  },
  reviews: {
    fontSize: fontSize.subhead,
  },
  card: {
    padding: 16,
    borderRadius: radius.card,
    marginBottom: 14,
  },
  cardLabel: {
    fontSize: fontSize.body,
    fontWeight: '600',
    marginBottom: 12,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    alignSelf: 'flex-start',
  },
  stepperBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperGlyph: {
    fontSize: 20,
    fontWeight: '600',
  },
  quantityValue: {
    fontSize: fontSize.body,
    fontWeight: '600',
    minWidth: 28,
    textAlign: 'center',
  },
  segmented: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: 9,
    marginBottom: 14,
  },
  segment: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 7,
  },
  segmentText: {
    fontSize: fontSize.subhead,
  },
  description: {
    fontSize: fontSize.body,
    lineHeight: lineHeight.body,
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 11,
  },
  specLabel: {
    fontSize: fontSize.subhead,
  },
  specValue: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  reviewCard: {
    paddingVertical: 12,
  },
  reviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  reviewerName: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  reviewRating: {
    fontSize: fontSize.caption1,
  },
  reviewComment: {
    fontSize: fontSize.subhead,
    marginBottom: 4,
    lineHeight: lineHeight.subhead,
  },
  reviewDate: {
    fontSize: fontSize.caption1,
  },
  inCartBadge: {
    padding: 12,
    borderRadius: radius.card,
    alignItems: 'center',
  },
  inCartText: {
    fontWeight: '600',
    fontSize: fontSize.subhead,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 12,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bottomPriceContainer: {
    flex: 1,
  },
  bottomPriceLabel: {
    fontSize: fontSize.footnote,
  },
  bottomPrice: {
    fontSize: fontSize.title2,
    fontWeight: '700',
  },
  addToCartButton: {
    paddingHorizontal: 26,
    paddingVertical: 14,
    borderRadius: radius.button,
  },
  addToCartText: {
    color: '#FFFFFF',
    fontSize: fontSize.body,
    fontWeight: '600',
  },
});
