import { useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, Image, Alert, Pressable } from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useCartStore, useSettingsStore } from '../../../store';
import { useTheme, type Theme } from '../../../theme';
import * as Haptics from 'expo-haptics';

function CartItem({
  item,
  styles,
  theme,
}: {
  item: ReturnType<typeof useCartStore.getState>['items'][0];
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
}) {
  const updateQuantity = useCartStore((state) => state.updateQuantity);
  const removeFromCart = useCartStore((state) => state.removeFromCart);
  const hapticEnabled = useSettingsStore((state) => state.preferences.hapticFeedback);
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
    <View style={styles.cartItem} testID={`cart-item-${item.product.id}`}>
      <Pressable onPress={() => router.push(`/product/${item.product.id}`)}>
        <Image source={{ uri: item.product.image }} style={styles.itemImage} />
      </Pressable>
      <View style={styles.itemContent}>
        <Text style={styles.itemCategory}>{item.product.category.toUpperCase()}</Text>
        <Text style={styles.itemName} numberOfLines={2}>
          {item.product.name}
        </Text>
        <Text style={styles.itemPrice}>${item.product.price.toFixed(2)}</Text>
        <View style={styles.itemActions}>
          <View style={styles.quantityContainer}>
            <Pressable
              style={styles.quantityBtn}
              onPress={() => handleQuantityChange(-1)}
              testID={`decrease-qty-${item.product.id}`}
            >
              <Ionicons name="remove" size={16} color={theme.colors.text.primary} />
            </Pressable>
            <Text style={styles.quantity} testID={`qty-${item.product.id}`}>
              {item.quantity}
            </Text>
            <Pressable
              style={styles.quantityBtn}
              onPress={() => handleQuantityChange(1)}
              testID={`increase-qty-${item.product.id}`}
            >
              <Ionicons name="add" size={16} color={theme.colors.text.primary} />
            </Pressable>
          </View>
          <Pressable
            style={styles.removeBtn}
            onPress={handleRemove}
            testID={`remove-item-${item.product.id}`}
          >
            <Ionicons name="trash-outline" size={18} color={theme.colors.text.muted} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function CartSummary({ styles }: { styles: ReturnType<typeof createStyles> }) {
  const subtotal = useCartStore((state) => state.getSubtotal());
  const tax = useCartStore((state) => state.getTax());
  const total = useCartStore((state) => state.getTotal());

  return (
    <View style={styles.summary} testID="cart-summary">
      <View style={styles.summaryRow}>
        <Text style={styles.summaryLabel}>Subtotal</Text>
        <Text style={styles.summaryValue}>${subtotal.toFixed(2)}</Text>
      </View>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryLabel}>Tax (10%)</Text>
        <Text style={styles.summaryValue}>${tax.toFixed(2)}</Text>
      </View>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryLabel}>Shipping</Text>
        <Text style={styles.freeShipping}>FREE</Text>
      </View>
      <View style={styles.divider} />
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue} testID="cart-total">
          ${total.toFixed(2)}
        </Text>
      </View>
    </View>
  );
}

export default function CartScreen() {
  const items = useCartStore((state) => state.items);
  const clearCart = useCartStore((state) => state.clearCart);
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
        style={{ flex: 1, backgroundColor: theme.colors.background.primary }}
        testID="cart-root"
      >
        <View
          style={[styles.emptyContainer, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT }]}
          testID="cart-screen-empty"
        >
          <View style={styles.emptyIconWrap}>
            <Ionicons name="bag-outline" size={40} color={theme.colors.accent.champagneDeep} />
          </View>
          <Text style={styles.emptyTitle}>Your cart is empty</Text>
          <Text style={styles.emptySubtitle}>Discover something elevated to fill it</Text>
          <PressableScale
            style={styles.shopButton}
            onPress={() => router.push('/(tabs)/(products)')}
            testID="browse-products-btn"
          >
            <Text style={styles.shopButtonText}>Browse Products</Text>
          </PressableScale>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background.primary }} testID="cart-root">
      <View
        style={[styles.container, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT }]}
        testID="cart-screen"
      >
        <FlatList
          data={items}
          keyExtractor={(item) => item.product.id}
          renderItem={({ item }) => <CartItem item={item} styles={styles} theme={theme} />}
          contentContainerStyle={styles.list}
          testID="cart-items-list"
          contentInsetAdjustmentBehavior="automatic"
          ListHeaderComponent={
            <View style={styles.header}>
              <Text style={styles.headerTitle}>
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </Text>
              <PressableScale onPress={handleClearCart} testID="clear-cart-btn">
                <Text style={styles.clearText}>Clear All</Text>
              </PressableScale>
            </View>
          }
        />

        <View style={styles.footer}>
          <CartSummary styles={styles} />
          <PressableScale
            style={styles.checkoutButton}
            onPress={handleCheckout}
            testID="checkout-btn"
          >
            <Text style={styles.checkoutText}>Proceed to Checkout</Text>
            <Ionicons name="arrow-forward" size={18} color={theme.colors.text.onAccent} />
          </PressableScale>
        </View>
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.primary,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 4,
      paddingVertical: 8,
      marginBottom: 4,
    },
    headerTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text.muted,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    clearText: {
      color: theme.colors.danger,
      fontWeight: '600',
      fontSize: 13,
    },

    list: {
      paddingHorizontal: 16,
      paddingTop: 8,
    },

    cartItem: {
      flexDirection: 'row',
      backgroundColor: theme.colors.background.elevated,
      borderRadius: theme.radii.lg,
      padding: 14,
      marginBottom: 12,
      ...theme.shadows.soft,
    },
    itemImage: {
      width: 84,
      height: 84,
      borderRadius: theme.radii.md,
      backgroundColor: theme.colors.background.tonal,
    },
    itemContent: {
      flex: 1,
      marginLeft: 14,
    },
    itemCategory: {
      fontSize: 10,
      color: theme.colors.text.muted,
      letterSpacing: 1.2,
      fontWeight: '600',
    },
    itemName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text.primary,
      marginTop: 2,
      letterSpacing: -0.2,
    },
    itemPrice: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text.primary,
      marginTop: 6,
      letterSpacing: -0.3,
    },
    itemActions: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 10,
    },
    quantityContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.background.tonal,
      borderRadius: theme.radii.pill,
    },
    quantityBtn: {
      width: 28,
      height: 28,
      borderRadius: theme.radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    quantity: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text.primary,
      minWidth: 22,
      textAlign: 'center',
    },
    removeBtn: {
      padding: 8,
    },

    footer: {
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    summary: {
      backgroundColor: theme.colors.background.elevated,
      borderRadius: theme.radii.lg,
      padding: 18,
      marginBottom: 14,
      ...theme.shadows.soft,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    summaryLabel: {
      fontSize: 14,
      color: theme.colors.text.muted,
    },
    summaryValue: {
      fontSize: 14,
      color: theme.colors.text.primary,
      fontWeight: '500',
    },
    freeShipping: {
      fontSize: 13,
      color: theme.colors.success,
      fontWeight: '700',
      letterSpacing: 0.4,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.divider,
      marginVertical: 8,
    },
    totalRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 4,
    },
    totalLabel: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text.primary,
    },
    totalValue: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.text.primary,
      letterSpacing: -0.5,
    },
    checkoutButton: {
      flexDirection: 'row',
      backgroundColor: theme.colors.accent.ink,
      paddingVertical: 16,
      borderRadius: theme.radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      ...theme.shadows.depth,
    },
    checkoutText: {
      color: theme.colors.text.onAccent,
      fontSize: 15,
      fontWeight: '700',
      letterSpacing: 0.3,
    },

    emptyContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 40,
    },
    emptyIconWrap: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: theme.colors.background.tonal,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 22,
      ...theme.shadows.soft,
    },
    emptyTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.text.primary,
      marginBottom: 8,
      letterSpacing: -0.4,
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.text.muted,
      textAlign: 'center',
      marginBottom: 26,
      maxWidth: 280,
    },
    shopButton: {
      backgroundColor: theme.colors.accent.ink,
      paddingHorizontal: 32,
      paddingVertical: 14,
      borderRadius: theme.radii.pill,
    },
    shopButtonText: {
      color: theme.colors.text.onAccent,
      fontWeight: '600',
      fontSize: 15,
      letterSpacing: 0.3,
    },
  });
