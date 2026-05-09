import { View, Text, StyleSheet, ScrollView, Image, Alert, Pressable } from 'react-native';
import { PressableScale } from 'pressto';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useProductsStore, useCartStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const products = useProductsStore(state => state.products);
  const addToCart = useCartStore(state => state.addToCart);
  const cartItems = useCartStore(state => state.items);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  const [quantity, setQuantity] = useState(1);
  const [selectedTab, setSelectedTab] = useState<'description' | 'specs' | 'reviews'>('description');

  const product = products.find(p => p.id === id);
  const inCart = cartItems.find(item => item.product.id === id);

  if (!product) {
    return (
      <View style={[styles.container, styles.centered, darkMode && styles.containerDark]}>
        <Text style={[styles.errorText, darkMode && styles.textLight]}>Product not found</Text>
        <PressableScale style={styles.backButton} onPress={() => router.back()}>
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
        { text: 'View Cart', onPress: () => { router.dismissAll(); router.push('/(tabs)/(cart)'); } },
      ]
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
      <Stack.Screen options={{ title: product.name }} />
      <ScrollView
        style={[styles.container, darkMode && styles.containerDark]}
        contentInsetAdjustmentBehavior="automatic"
        testID="product-detail-screen"
      >
        <Image source={{ uri: product.image }} style={styles.productImage} />

        {!product.inStock && (
          <View style={styles.outOfStockBanner}>
            <Text style={styles.outOfStockText}>Out of Stock</Text>
          </View>
        )}

        <View style={styles.content}>
          <View style={styles.header}>
            <Text style={[styles.category, darkMode && styles.subtitleDark]}>{product.category}</Text>
            <View style={styles.ratingBadge}>
              <Text style={styles.ratingText}>⭐ {product.rating}</Text>
            </View>
          </View>

          <Text style={[styles.title, darkMode && styles.textLight]} testID="product-title">
            {product.name}
          </Text>

          <View style={styles.priceRow}>
            <Text style={styles.price} testID="product-price">${product.price.toFixed(2)}</Text>
            <Text style={[styles.reviews, darkMode && styles.subtitleDark]}>
              {product.reviews} reviews
            </Text>
          </View>

          {/* Quantity Selector */}
          <View style={[styles.quantitySection, darkMode && styles.cardDark]}>
            <Text style={[styles.quantityLabel, darkMode && styles.textLight]}>Quantity:</Text>
            <View style={styles.quantityControls}>
              <Pressable
                style={styles.quantityBtn}
                onPress={() => handleQuantityChange(-1)}
                testID="decrease-quantity"
              >
                <Text style={styles.quantityBtnText}>−</Text>
              </Pressable>
              <Text style={[styles.quantityValue, darkMode && styles.textLight]} testID="quantity-value">
                {quantity}
              </Text>
              <Pressable
                style={styles.quantityBtn}
                onPress={() => handleQuantityChange(1)}
                testID="increase-quantity"
              >
                <Text style={styles.quantityBtnText}>+</Text>
              </Pressable>
            </View>
          </View>

          {/* Tab Navigation */}
          <View style={styles.tabContainer}>
            {(['description', 'specs', 'reviews'] as const).map(tab => (
              <PressableScale
                key={tab}
                style={[styles.tab, selectedTab === tab && styles.tabActive]}
                onPress={() => setSelectedTab(tab)}
                testID={`tab-${tab}`}
              >
                <Text style={[
                  styles.tabText,
                  darkMode && styles.subtitleDark,
                  selectedTab === tab && styles.tabTextActive,
                ]}>
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </Text>
              </PressableScale>
            ))}
          </View>

          {/* Tab Content */}
          <View style={[styles.tabContent, darkMode && styles.cardDark]}>
            {selectedTab === 'description' && (
              <Text style={[styles.description, darkMode && styles.subtitleDark]} testID="product-description">
                {product.description}
              </Text>
            )}
            {selectedTab === 'specs' && (
              <View testID="product-specs">
                <SpecRow label="Category" value={product.category} darkMode={darkMode} />
                <SpecRow label="Rating" value={`${product.rating} / 5.0`} darkMode={darkMode} />
                <SpecRow label="Reviews" value={`${product.reviews} reviews`} darkMode={darkMode} />
                <SpecRow label="Availability" value={product.inStock ? 'In Stock' : 'Out of Stock'} darkMode={darkMode} />
                <SpecRow label="SKU" value={`SKU-${product.id.toUpperCase()}`} darkMode={darkMode} />
              </View>
            )}
            {selectedTab === 'reviews' && (
              <View testID="product-reviews">
                <ReviewCard
                  name="John D."
                  rating={5}
                  comment="Excellent product! Highly recommended."
                  date="2 days ago"
                  darkMode={darkMode}
                />
                <ReviewCard
                  name="Sarah M."
                  rating={4}
                  comment="Great quality, fast shipping."
                  date="1 week ago"
                  darkMode={darkMode}
                />
                <ReviewCard
                  name="Mike T."
                  rating={5}
                  comment="Exactly as described. Very happy with my purchase."
                  date="2 weeks ago"
                  darkMode={darkMode}
                />
              </View>
            )}
          </View>

          {inCart && (
            <View style={styles.inCartBadge}>
              <Text style={styles.inCartText}>
                ✓ {inCart.quantity} already in cart
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Fixed Bottom Bar */}
      <View style={[styles.bottomBar, darkMode && styles.bottomBarDark]}>
        <View style={styles.bottomPriceContainer}>
          <Text style={[styles.bottomPriceLabel, darkMode && styles.subtitleDark]}>Total:</Text>
          <Text style={styles.bottomPrice}>${(product.price * quantity).toFixed(2)}</Text>
        </View>
        <PressableScale
          style={[styles.addToCartButton, !product.inStock && styles.addToCartButtonDisabled]}
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

function SpecRow({ label, value, darkMode }: { label: string; value: string; darkMode: boolean }) {
  return (
    <View style={styles.specRow}>
      <Text style={[styles.specLabel, darkMode && styles.subtitleDark]}>{label}</Text>
      <Text style={[styles.specValue, darkMode && styles.textLight]}>{value}</Text>
    </View>
  );
}

function ReviewCard({
  name,
  rating,
  comment,
  date,
  darkMode,
}: {
  name: string;
  rating: number;
  comment: string;
  date: string;
  darkMode: boolean;
}) {
  return (
    <View style={[styles.reviewCard, darkMode && styles.reviewCardDark]}>
      <View style={styles.reviewHeader}>
        <Text style={[styles.reviewerName, darkMode && styles.textLight]}>{name}</Text>
        <Text style={styles.reviewRating}>{'⭐'.repeat(rating)}</Text>
      </View>
      <Text style={[styles.reviewComment, darkMode && styles.subtitleDark]}>{comment}</Text>
      <Text style={[styles.reviewDate, darkMode && styles.subtitleDark]}>{date}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  containerDark: {
    backgroundColor: '#16213e',
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 18,
    color: '#666',
    marginBottom: 20,
  },
  textLight: {
    color: '#fff',
  },
  subtitleDark: {
    color: '#aaa',
  },
  cardDark: {
    backgroundColor: '#1a1a2e',
  },
  backButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  backButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  productImage: {
    width: '100%',
    height: 300,
    backgroundColor: '#f0f0f0',
  },
  outOfStockBanner: {
    backgroundColor: '#FF3B30',
    padding: 10,
    alignItems: 'center',
  },
  outOfStockText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  content: {
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  category: {
    fontSize: 14,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  ratingBadge: {
    backgroundColor: '#FFF9E6',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  ratingText: {
    fontSize: 14,
    fontWeight: '600',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 10,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  price: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  reviews: {
    fontSize: 14,
    color: '#666',
  },
  quantitySection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  quantityLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  quantityControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  quantityBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quantityBtnText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  quantityValue: {
    fontSize: 18,
    fontWeight: '600',
    marginHorizontal: 20,
    minWidth: 30,
    textAlign: 'center',
  },
  tabContainer: {
    flexDirection: 'row',
    marginBottom: 15,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#007AFF',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#666',
  },
  tabTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  tabContent: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  description: {
    fontSize: 15,
    lineHeight: 24,
    color: '#444',
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  specLabel: {
    fontSize: 14,
    color: '#666',
  },
  specValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  reviewCard: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  reviewCardDark: {
    borderBottomColor: '#2a2a3e',
  },
  reviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  reviewerName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  reviewRating: {
    fontSize: 12,
  },
  reviewComment: {
    fontSize: 14,
    color: '#444',
    marginBottom: 4,
  },
  reviewDate: {
    fontSize: 12,
    color: '#999',
  },
  inCartBadge: {
    backgroundColor: '#E8F5E9',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  inCartText: {
    color: '#4CAF50',
    fontWeight: '600',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  bottomBarDark: {
    backgroundColor: '#1a1a2e',
    borderTopColor: '#2a2a3e',
  },
  bottomPriceContainer: {
    flex: 1,
  },
  bottomPriceLabel: {
    fontSize: 12,
    color: '#666',
  },
  bottomPrice: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  addToCartButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  addToCartButtonDisabled: {
    backgroundColor: '#ccc',
  },
  addToCartText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
