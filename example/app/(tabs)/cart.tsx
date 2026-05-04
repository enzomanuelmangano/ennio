import { View, Text, StyleSheet, FlatList, Image, Alert } from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCartStore, useAuthStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';

function CartItem({ item }: { item: ReturnType<typeof useCartStore.getState>['items'][0] }) {
  const updateQuantity = useCartStore(state => state.updateQuantity);
  const removeFromCart = useCartStore(state => state.removeFromCart);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const router = useRouter();

  const handleQuantityChange = (delta: number) => {
    const newQuantity = item.quantity + delta;
    if (newQuantity <= 0) {
      handleRemove();
    } else {
      updateQuantity(item.product.id, newQuantity);
      if (hapticEnabled) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  };

  const handleRemove = () => {
    removeFromCart(item.product.id);
    if (hapticEnabled) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  };

  return (
    <View style={[styles.cartItem, darkMode && styles.cardDark]} testID={`cart-item-${item.product.id}`}>
      <PressableScale onPress={() => router.push(`/product/${item.product.id}`)}>
        <Image source={{ uri: item.product.image }} style={styles.itemImage} />
      </PressableScale>
      <View style={styles.itemContent}>
        <Text style={[styles.itemName, darkMode && styles.textLight]} numberOfLines={2}>
          {item.product.name}
        </Text>
        <Text style={[styles.itemCategory, darkMode && styles.subtitleDark]}>
          {item.product.category}
        </Text>
        <Text style={styles.itemPrice}>
          ${item.product.price.toFixed(2)}
        </Text>
      </View>
      <View style={styles.quantityContainer}>
        <PressableScale
          style={styles.quantityBtn}
          onPress={() => handleQuantityChange(-1)}
          testID={`decrease-qty-${item.product.id}`}
        >
          <Text style={styles.quantityBtnText}>−</Text>
        </PressableScale>
        <Text style={[styles.quantity, darkMode && styles.textLight]} testID={`qty-${item.product.id}`}>
          {item.quantity}
        </Text>
        <PressableScale
          style={styles.quantityBtn}
          onPress={() => handleQuantityChange(1)}
          testID={`increase-qty-${item.product.id}`}
        >
          <Text style={styles.quantityBtnText}>+</Text>
        </PressableScale>
      </View>
      <PressableScale
        style={styles.removeBtn}
        onPress={handleRemove}
        testID={`remove-item-${item.product.id}`}
      >
        <Text style={styles.removeText}>🗑️</Text>
      </PressableScale>
    </View>
  );
}

function CartSummary() {
  const subtotal = useCartStore(state => state.getSubtotal());
  const tax = useCartStore(state => state.getTax());
  const total = useCartStore(state => state.getTotal());
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <View style={[styles.summary, darkMode && styles.cardDark]} testID="cart-summary">
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryLabel, darkMode && styles.subtitleDark]}>Subtotal</Text>
        <Text style={[styles.summaryValue, darkMode && styles.textLight]}>${subtotal.toFixed(2)}</Text>
      </View>
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryLabel, darkMode && styles.subtitleDark]}>Tax (10%)</Text>
        <Text style={[styles.summaryValue, darkMode && styles.textLight]}>${tax.toFixed(2)}</Text>
      </View>
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryLabel, darkMode && styles.subtitleDark]}>Shipping</Text>
        <Text style={[styles.freeShipping, darkMode && styles.textLight]}>FREE</Text>
      </View>
      <View style={[styles.summaryRow, styles.totalRow]}>
        <Text style={[styles.totalLabel, darkMode && styles.textLight]}>Total</Text>
        <Text style={styles.totalValue} testID="cart-total">${total.toFixed(2)}</Text>
      </View>
    </View>
  );
}

export default function CartScreen() {
  const items = useCartStore(state => state.items);
  const clearCart = useCartStore(state => state.clearCart);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const TAB_BAR_HEIGHT = 49;

  const handleCheckout = () => {
    router.push('/checkout');
  };

  const handleClearCart = () => {
    Alert.alert(
      'Clear Cart',
      'Remove all items from your cart?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => clearCart() },
      ],
    );
  };

  if (items.length === 0) {
    return (
      <View style={[styles.emptyContainer, darkMode && styles.containerDark, { paddingTop: insets.top, paddingBottom: insets.bottom + TAB_BAR_HEIGHT }]} testID="cart-screen-empty">
        <Text style={styles.emptyIcon}>🛒</Text>
        <Text style={[styles.emptyTitle, darkMode && styles.textLight]}>Your cart is empty</Text>
        <Text style={[styles.emptySubtitle, darkMode && styles.subtitleDark]}>
          Add some products to get started
        </Text>
        <PressableScale
          style={styles.shopButton}
          onPress={() => router.push('/products')}
          testID="browse-products-btn"
        >
          <Text style={styles.shopButtonText}>Browse Products</Text>
        </PressableScale>
      </View>
    );
  }

  return (
    <View style={[styles.container, darkMode && styles.containerDark, { paddingTop: insets.top, paddingBottom: insets.bottom + TAB_BAR_HEIGHT }]} testID="cart-screen">
      <View style={styles.header}>
        <Text style={[styles.headerTitle, darkMode && styles.textLight]}>
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </Text>
        <PressableScale onPress={handleClearCart} testID="clear-cart-btn">
          <Text style={styles.clearText}>Clear All</Text>
        </PressableScale>
      </View>

      <FlatList
        data={items}
        keyExtractor={item => item.product.id}
        renderItem={({ item }) => <CartItem item={item} />}
        contentContainerStyle={styles.list}
        testID="cart-items-list"
      />

      <View style={styles.footer}>
        <CartSummary />
        <PressableScale
          style={styles.checkoutButton}
          onPress={handleCheckout}
          testID="checkout-btn"
        >
          <Text style={styles.checkoutText}>Proceed to Checkout</Text>
        </PressableScale>
      </View>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 15,
    paddingBottom: 10,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  clearText: {
    color: '#FF3B30',
    fontWeight: '500',
  },
  list: {
    padding: 15,
    paddingTop: 0,
  },
  cartItem: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  cardDark: {
    backgroundColor: '#1a1a2e',
  },
  textLight: {
    color: '#fff',
  },
  subtitleDark: {
    color: '#aaa',
  },
  itemImage: {
    width: 70,
    height: 70,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  itemContent: {
    flex: 1,
    marginLeft: 12,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  itemCategory: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  itemPrice: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#007AFF',
    marginTop: 4,
  },
  quantityContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  quantityBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quantityBtnText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  quantity: {
    fontSize: 16,
    fontWeight: '600',
    marginHorizontal: 12,
    minWidth: 20,
    textAlign: 'center',
  },
  removeBtn: {
    padding: 8,
  },
  removeText: {
    fontSize: 18,
  },
  footer: {
    padding: 15,
    paddingTop: 0,
  },
  summary: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  summaryLabel: {
    fontSize: 14,
    color: '#666',
  },
  summaryValue: {
    fontSize: 14,
    color: '#333',
  },
  freeShipping: {
    fontSize: 14,
    color: '#34C759',
    fontWeight: '600',
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 12,
    marginTop: 5,
    marginBottom: 0,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  totalValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  checkoutButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  checkoutText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyIcon: {
    fontSize: 80,
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 10,
  },
  emptySubtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 25,
  },
  shopButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 14,
    borderRadius: 25,
  },
  shopButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
});
