import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter, Stack } from 'expo-router';
import { useCartStore, useSettingsStore, useAuthStore } from '../store';
import { useState } from 'react';
import { colors, fontSize, lineHeight, radius } from '../src/theme';

type Palette = ReturnType<typeof colors>;

type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled';

function statusTint(c: Palette, status: OrderStatus) {
  switch (status) {
    case 'processing':
      return c.systemOrange;
    case 'shipped':
      return c.systemBlue;
    case 'delivered':
      return c.systemGreen;
    case 'cancelled':
      return c.systemRed;
    default:
      return c.secondaryLabel;
  }
}

function statusGlyph(status: OrderStatus) {
  switch (status) {
    case 'processing':
      return '◷';
    case 'shipped':
      return '⇄';
    case 'delivered':
      return '✓';
    case 'cancelled':
      return '✕';
    default:
      return '●';
  }
}

function StatusPill({ status, c }: { status: OrderStatus; c: Palette }) {
  const tint = statusTint(c, status);
  return (
    <View style={[styles.statusPill, { backgroundColor: tint + '22' }]}>
      <Text style={[styles.statusGlyph, { color: tint }]}>
        {statusGlyph(status)}
      </Text>
      <Text style={[styles.statusText, { color: tint }]}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Text>
    </View>
  );
}

function OrderCard({
  order,
  c,
  onPress,
}: {
  order: ReturnType<typeof useCartStore.getState>['orders'][0];
  c: Palette;
  onPress: () => void;
}) {
  const firstItem = order.items[0];
  const moreCount = order.items.length - 1;
  const status = order.status as OrderStatus;

  return (
    <PressableScale
      style={StyleSheet.flatten([
        styles.orderCard,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ])}
      onPress={onPress}
      testID={`order-${order.id}`}
    >
      <View style={styles.orderHeader}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.orderId, { color: c.label }]}>
            Order #{order.id.slice(0, 8)}
          </Text>
          <Text style={[styles.orderDate, { color: c.secondaryLabel }]}>
            {new Date(order.date).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </Text>
        </View>
        <StatusPill status={status} c={c} />
      </View>

      <View
        style={[styles.orderItemsRow, { borderTopColor: c.separator }]}
      >
        {firstItem && (
          <View style={styles.itemPreview}>
            <Image
              source={{ uri: firstItem.product.image }}
              style={styles.itemImage}
            />
            <View style={styles.itemInfo}>
              <Text
                style={[styles.itemName, { color: c.label }]}
                numberOfLines={1}
              >
                {firstItem.product.name}
              </Text>
              <Text style={[styles.itemQty, { color: c.secondaryLabel }]}>
                Qty {firstItem.quantity}
                {moreCount > 0 &&
                  ` · +${moreCount} more item${moreCount > 1 ? 's' : ''}`}
              </Text>
            </View>
          </View>
        )}
      </View>

      <View
        style={[styles.orderFooter, { borderTopColor: c.separator }]}
      >
        <Text style={[styles.totalLabel, { color: c.secondaryLabel }]}>
          Total
        </Text>
        <View style={styles.footerRight}>
          <Text style={[styles.totalValue, { color: c.label }]}>
            ${order.total.toFixed(2)}
          </Text>
          <Text style={[styles.chevron, { color: c.tertiaryLabel }]}>›</Text>
        </View>
      </View>
    </PressableScale>
  );
}

function OrderDetails({
  order,
  c,
  onClose,
}: {
  order: ReturnType<typeof useCartStore.getState>['orders'][0];
  c: Palette;
  onClose: () => void;
}) {
  const status = order.status as OrderStatus;

  return (
    <View style={styles.detailsOverlay} testID="order-details">
      <View
        style={[
          styles.detailsContent,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        <View style={styles.detailsHeader}>
          <Text style={[styles.detailsTitle, { color: c.label }]}>
            Order Details
          </Text>
          <PressableScale
            onPress={onClose}
            testID="close-details"
            hitSlop={8}
            style={[
              styles.closeBtnCircle,
              { backgroundColor: c.tertiarySystemFill },
            ]}
          >
            <Text style={[styles.closeBtn, { color: c.label }]}>✕</Text>
          </PressableScale>
        </View>

        <View style={styles.detailsSection}>
          <Text style={[styles.detailsLabel, { color: c.secondaryLabel }]}>
            Order ID
          </Text>
          <Text style={[styles.detailsValue, { color: c.label }]}>
            {order.id}
          </Text>
        </View>

        <View style={styles.detailsSection}>
          <Text style={[styles.detailsLabel, { color: c.secondaryLabel }]}>
            Status
          </Text>
          <View style={{ alignSelf: 'flex-start', marginTop: 4 }}>
            <StatusPill status={status} c={c} />
          </View>
        </View>

        <View style={styles.detailsSection}>
          <Text style={[styles.detailsLabel, { color: c.secondaryLabel }]}>
            Shipping Address
          </Text>
          <Text style={[styles.detailsValue, { color: c.label }]}>
            {order.shippingAddress}
          </Text>
        </View>

        <View style={styles.detailsSection}>
          <Text style={[styles.detailsLabel, { color: c.secondaryLabel }]}>
            Items
          </Text>
          {order.items.map((item, idx) => (
            <View
              key={item.product.id}
              style={[
                styles.detailItem,
                idx < order.items.length - 1 && {
                  borderBottomColor: c.separator,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Image
                source={{ uri: item.product.image }}
                style={styles.detailItemImage}
              />
              <View style={styles.detailItemInfo}>
                <Text
                  style={[styles.detailItemName, { color: c.label }]}
                  numberOfLines={1}
                >
                  {item.product.name}
                </Text>
                <Text
                  style={[
                    styles.detailItemMeta,
                    { color: c.secondaryLabel },
                  ]}
                >
                  ${item.product.price.toFixed(2)} × {item.quantity}
                </Text>
              </View>
              <Text style={[styles.detailItemTotal, { color: c.label }]}>
                ${(item.product.price * item.quantity).toFixed(2)}
              </Text>
            </View>
          ))}
        </View>

        <View
          style={[
            styles.detailsTotalSection,
            { borderTopColor: c.separator },
          ]}
        >
          <Text style={[styles.detailsTotalLabel, { color: c.label }]}>
            Total
          </Text>
          <Text style={[styles.detailsTotalValue, { color: c.label }]}>
            ${order.total.toFixed(2)}
          </Text>
        </View>

        <PressableScale
          style={[styles.trackButton, { backgroundColor: c.systemBlue }]}
          onPress={onClose}
          testID="track-order"
        >
          <Text style={styles.trackButtonText}>Track Order</Text>
        </PressableScale>
      </View>
    </View>
  );
}

function EmptyOrders({
  c,
  onBrowse,
}: {
  c: Palette;
  onBrowse: () => void;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.systemGroupedBackground,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
      testID="empty-orders"
    >
      <View
        style={[styles.emptyIconBg, { backgroundColor: c.tertiarySystemFill }]}
      >
        <Text style={[styles.emptyIcon, { color: c.secondaryLabel }]}>◫</Text>
      </View>
      <Text style={[styles.emptyTitle, { color: c.label }]}>
        No orders yet
      </Text>
      <Text style={[styles.emptySubtitle, { color: c.secondaryLabel }]}>
        Start shopping to see your orders here
      </Text>
      <PressableScale
        style={[styles.browseButton, { backgroundColor: c.systemBlue }]}
        onPress={onBrowse}
        testID="browse-products"
      >
        <Text style={styles.browseButtonText}>Browse Products</Text>
      </PressableScale>
    </View>
  );
}

export default function OrdersScreen() {
  const router = useRouter();
  const orders = useCartStore(state => state.orders);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);
  const [selectedOrder, setSelectedOrder] = useState<typeof orders[0] | null>(
    null,
  );

  const sortedOrders = [...orders].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  if (!isAuthenticated) {
    return (
      <>
        <Stack.Screen
          options={{
            title: 'Orders',
            headerStyle: { backgroundColor: c.systemBackground },
            headerTintColor: c.label,
          }}
        />
        <View
          style={{
            flex: 1,
            backgroundColor: c.systemGroupedBackground,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
          }}
          testID="orders-guest"
        >
          <View
            style={[
              styles.emptyIconBg,
              { backgroundColor: c.systemBlue + '22' },
            ]}
          >
            <Text style={[styles.emptyIcon, { color: c.systemBlue }]}>⚿</Text>
          </View>
          <Text style={[styles.emptyTitle, { color: c.label }]}>
            Sign in to view orders
          </Text>
          <Text style={[styles.emptySubtitle, { color: c.secondaryLabel }]}>
            You need to be signed in to view your order history
          </Text>
          <PressableScale
            style={[styles.browseButton, { backgroundColor: c.systemBlue }]}
            onPress={() => router.push('/auth/login')}
            testID="sign-in-btn"
          >
            <Text style={styles.browseButtonText}>Sign In</Text>
          </PressableScale>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'My Orders',
          headerStyle: { backgroundColor: c.systemBackground },
          headerTintColor: c.label,
        }}
      />
      <View
        style={{ flex: 1, backgroundColor: c.systemGroupedBackground }}
        testID="orders-screen"
      >
        {sortedOrders.length === 0 ? (
          <EmptyOrders c={c} onBrowse={() => router.push('/products')} />
        ) : (
          <>
            <View style={styles.header}>
              <Text style={[styles.headerTitle, { color: c.secondaryLabel }]}>
                {sortedOrders.length} ORDER
                {sortedOrders.length !== 1 ? 'S' : ''}
              </Text>
            </View>
            <FlatList
              data={sortedOrders}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <OrderCard
                  order={item}
                  c={c}
                  onPress={() => setSelectedOrder(item)}
                />
              )}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              testID="orders-list"
            />
          </>
        )}

        {selectedOrder && (
          <OrderDetails
            order={selectedOrder}
            c={c}
            onClose={() => setSelectedOrder(null)}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 32,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: fontSize.footnote,
    fontWeight: '400',
    letterSpacing: 0.4,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  orderCard: {
    borderRadius: radius.card,
    padding: 16,
    marginBottom: 12,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  orderId: {
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  orderDate: {
    fontSize: fontSize.footnote,
    marginTop: 2,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  statusGlyph: {
    fontSize: 11,
    fontWeight: '700',
    marginRight: 4,
  },
  statusText: {
    fontSize: fontSize.caption1,
    fontWeight: '700',
  },
  orderItemsRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    marginBottom: 12,
  },
  itemPreview: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemImage: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  itemInfo: {
    flex: 1,
    marginLeft: 12,
  },
  itemName: {
    fontSize: fontSize.subhead,
    fontWeight: '500',
  },
  itemQty: {
    fontSize: fontSize.caption1,
    marginTop: 2,
  },
  orderFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
  },
  totalLabel: {
    fontSize: fontSize.footnote,
    fontWeight: '500',
  },
  footerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  totalValue: {
    fontSize: fontSize.title3,
    fontWeight: '700',
  },
  chevron: {
    fontSize: 22,
    fontWeight: '500',
    marginLeft: 6,
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
    fontSize: 50,
    fontWeight: '600',
  },
  emptyTitle: {
    fontSize: fontSize.title2,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: fontSize.subhead,
    textAlign: 'center',
    marginBottom: 26,
  },
  browseButton: {
    paddingHorizontal: 30,
    paddingVertical: 14,
    borderRadius: radius.pill,
  },
  browseButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: fontSize.body,
  },
  detailsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  detailsContent: {
    borderRadius: radius.sheet,
    padding: 18,
    width: '100%',
    maxHeight: '90%',
  },
  detailsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  detailsTitle: {
    fontSize: fontSize.title3,
    fontWeight: '700',
  },
  closeBtnCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    fontSize: 14,
    fontWeight: '700',
  },
  detailsSection: {
    marginBottom: 14,
  },
  detailsLabel: {
    fontSize: fontSize.footnote,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  detailsValue: {
    fontSize: fontSize.body,
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  detailItemImage: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  detailItemInfo: {
    flex: 1,
    marginLeft: 10,
  },
  detailItemName: {
    fontSize: fontSize.subhead,
    fontWeight: '500',
  },
  detailItemMeta: {
    fontSize: fontSize.caption1,
  },
  detailItemTotal: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  detailsTotalSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 14,
    marginTop: 4,
    marginBottom: 18,
  },
  detailsTotalLabel: {
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  detailsTotalValue: {
    fontSize: fontSize.title2,
    fontWeight: '700',
  },
  trackButton: {
    paddingVertical: 14,
    borderRadius: radius.button,
    alignItems: 'center',
  },
  trackButtonText: {
    color: '#FFFFFF',
    fontSize: fontSize.body,
    fontWeight: '600',
  },
});
