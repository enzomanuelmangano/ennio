import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  Alert,
  Pressable,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCartStore, useAuthStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, lineHeight, radius } from '../../src/theme';

function CartItem({
  item,
  c,
  isLast,
}: {
  item: ReturnType<typeof useCartStore.getState>['items'][0];
  c: ReturnType<typeof colors>;
  isLast: boolean;
}) {
  const updateQuantity = useCartStore(state => state.updateQuantity);
  const removeFromCart = useCartStore(state => state.removeFromCart);
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );
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
    <View>
      <View style={styles.cartItem} testID={`cart-item-${item.product.id}`}>
        <Pressable onPress={() => router.push(`/product/${item.product.id}`)}>
          <Image source={{ uri: item.product.image }} style={styles.itemImage} />
        </Pressable>
        <View style={styles.itemContent}>
          <Text
            style={[styles.itemName, { color: c.label }]}
            numberOfLines={2}
          >
            {item.product.name}
          </Text>
          <Text style={[styles.itemCategory, { color: c.secondaryLabel }]}>
            {item.product.category}
          </Text>
          <View style={styles.itemBottom}>
            <Text style={[styles.itemPrice, { color: c.label }]}>
              ${item.product.price.toFixed(2)}
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
                testID={`decrease-qty-${item.product.id}`}
                hitSlop={4}
              >
                <Text style={[styles.stepperGlyph, { color: c.label }]}>
                  −
                </Text>
              </Pressable>
              <Text
                style={[styles.quantity, { color: c.label }]}
                testID={`qty-${item.product.id}`}
              >
                {item.quantity}
              </Text>
              <Pressable
                style={styles.stepperBtn}
                onPress={() => handleQuantityChange(1)}
                testID={`increase-qty-${item.product.id}`}
                hitSlop={4}
              >
                <Text style={[styles.stepperGlyph, { color: c.label }]}>
                  +
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
        <Pressable
          style={styles.removeBtn}
          onPress={handleRemove}
          testID={`remove-item-${item.product.id}`}
          hitSlop={8}
        >
          <Text style={[styles.removeGlyph, { color: c.systemRed }]}>×</Text>
        </Pressable>
      </View>
      {!isLast && (
        <View
          style={[
            styles.itemSeparator,
            { backgroundColor: c.separator },
          ]}
        />
      )}
    </View>
  );
}

function CartSummary({ c }: { c: ReturnType<typeof colors> }) {
  const subtotal = useCartStore(state => state.getSubtotal());
  const tax = useCartStore(state => state.getTax());
  const total = useCartStore(state => state.getTotal());

  return (
    <View
      style={[
        styles.summary,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ]}
      testID="cart-summary"
    >
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryLabel, { color: c.secondaryLabel }]}>
          Subtotal
        </Text>
        <Text style={[styles.summaryValue, { color: c.label }]}>
          ${subtotal.toFixed(2)}
        </Text>
      </View>
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryLabel, { color: c.secondaryLabel }]}>
          Tax (10%)
        </Text>
        <Text style={[styles.summaryValue, { color: c.label }]}>
          ${tax.toFixed(2)}
        </Text>
      </View>
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryLabel, { color: c.secondaryLabel }]}>
          Shipping
        </Text>
        <Text style={[styles.freeShipping, { color: c.systemGreen }]}>
          FREE
        </Text>
      </View>
      <View style={[styles.totalRow, { borderTopColor: c.separator }]}>
        <Text style={[styles.totalLabel, { color: c.label }]}>Total</Text>
        <Text
          style={[styles.totalValue, { color: c.label }]}
          testID="cart-total"
        >
          ${total.toFixed(2)}
        </Text>
      </View>
    </View>
  );
}

export default function CartScreen() {
  const items = useCartStore(state => state.items);
  const clearCart = useCartStore(state => state.clearCart);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const TAB_BAR_HEIGHT = 49;

  const handleCheckout = () => {
    router.push('/checkout');
  };

  const handleClearCart = () => {
    Alert.alert('Clear Cart', 'Remove all items from your cart?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => clearCart() },
    ]);
  };

  if (items.length === 0) {
    return (
      <View
        style={[
          styles.emptyContainer,
          { backgroundColor: c.systemGroupedBackground },
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + TAB_BAR_HEIGHT,
          },
        ]}
        testID="cart-screen-empty"
      >
        <View
          style={[
            styles.emptyIconBg,
            { backgroundColor: c.tertiarySystemFill },
          ]}
        >
          <Text style={[styles.emptyIcon, { color: c.secondaryLabel }]}>
            ◔
          </Text>
        </View>
        <Text style={[styles.emptyTitle, { color: c.label }]}>
          Your cart is empty
        </Text>
        <Text style={[styles.emptySubtitle, { color: c.secondaryLabel }]}>
          Add some products to get started
        </Text>
        <PressableScale
          style={[styles.shopButton, { backgroundColor: c.systemBlue }]}
          onPress={() => router.push('/products')}
          testID="browse-products-btn"
        >
          <Text style={styles.shopButtonText}>Browse Products</Text>
        </PressableScale>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: c.systemGroupedBackground },
        {
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT,
        },
      ]}
      testID="cart-screen"
    >
      <View style={styles.header}>
        <View style={styles.headerTextWrap}>
          <Text style={[styles.largeTitle, { color: c.label }]}>Cart</Text>
          <Text style={[styles.headerSubtitle, { color: c.secondaryLabel }]}>
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </Text>
        </View>
        <PressableScale
          onPress={handleClearCart}
          testID="clear-cart-btn"
          hitSlop={8}
        >
          <Text style={[styles.clearText, { color: c.systemRed }]}>
            Clear All
          </Text>
        </PressableScale>
      </View>

      <FlatList
        data={items}
        keyExtractor={item => item.product.id}
        renderItem={({ item, index }) => (
          <View
            style={[
              styles.itemRowCard,
              {
                backgroundColor: c.secondarySystemGroupedBackground,
                borderTopLeftRadius: index === 0 ? radius.card : 0,
                borderTopRightRadius: index === 0 ? radius.card : 0,
                borderBottomLeftRadius:
                  index === items.length - 1 ? radius.card : 0,
                borderBottomRightRadius:
                  index === items.length - 1 ? radius.card : 0,
              },
            ]}
          >
            <CartItem item={item} c={c} isLast={index === items.length - 1} />
          </View>
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        testID="cart-items-list"
        ListFooterComponent={
          <View>
            <CartSummary c={c} />
            <PressableScale
              style={[styles.checkoutButton, { backgroundColor: c.systemBlue }]}
              onPress={handleCheckout}
              testID="checkout-btn"
            >
              <Text style={styles.checkoutText}>Proceed to Checkout</Text>
            </PressableScale>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTextWrap: {
    flex: 1,
  },
  largeTitle: {
    fontSize: fontSize.largeTitle,
    lineHeight: lineHeight.largeTitle,
    fontWeight: '700',
    letterSpacing: 0.37,
  },
  headerSubtitle: {
    fontSize: fontSize.subhead,
    fontWeight: '500',
    marginTop: 2,
  },
  clearText: {
    fontSize: fontSize.body,
    fontWeight: '500',
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  itemRowCard: {
    overflow: 'hidden',
  },
  cartItem: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  itemImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  itemContent: {
    flex: 1,
    marginLeft: 12,
  },
  itemName: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  itemCategory: {
    fontSize: fontSize.caption1,
    marginTop: 1,
  },
  itemBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  itemPrice: {
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: 4,
  },
  stepperBtn: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperGlyph: {
    fontSize: 16,
    fontWeight: '600',
  },
  quantity: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
    minWidth: 18,
    textAlign: 'center',
  },
  removeBtn: {
    paddingLeft: 8,
    paddingVertical: 6,
  },
  removeGlyph: {
    fontSize: 26,
    fontWeight: '300',
    lineHeight: 26,
  },
  itemSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 84,
  },
  summary: {
    borderRadius: radius.card,
    padding: 16,
    marginTop: 16,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  summaryLabel: {
    fontSize: fontSize.subhead,
  },
  summaryValue: {
    fontSize: fontSize.subhead,
    fontWeight: '500',
  },
  freeShipping: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    marginTop: 4,
  },
  totalLabel: {
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  totalValue: {
    fontSize: fontSize.title3,
    fontWeight: '700',
  },
  checkoutButton: {
    paddingVertical: 16,
    borderRadius: radius.button,
    alignItems: 'center',
    marginTop: 16,
  },
  checkoutText: {
    color: '#FFFFFF',
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyIconBg: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: fontSize.title2,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: fontSize.subhead,
    textAlign: 'center',
    marginBottom: 26,
  },
  shopButton: {
    paddingHorizontal: 30,
    paddingVertical: 14,
    borderRadius: radius.pill,
  },
  shopButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: fontSize.body,
  },
});
