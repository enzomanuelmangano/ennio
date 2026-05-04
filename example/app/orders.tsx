import { View, Text, StyleSheet, FlatList, Image } from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter, Stack } from 'expo-router';
import { useCartStore, useSettingsStore, useAuthStore } from '../store';
import { useState } from 'react';

type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled';

function getStatusColor(status: OrderStatus) {
  switch (status) {
    case 'processing':
      return '#FF9500';
    case 'shipped':
      return '#007AFF';
    case 'delivered':
      return '#34C759';
    case 'cancelled':
      return '#FF3B30';
    default:
      return '#666';
  }
}

function getStatusIcon(status: OrderStatus) {
  switch (status) {
    case 'processing':
      return '⏳';
    case 'shipped':
      return '🚚';
    case 'delivered':
      return '✅';
    case 'cancelled':
      return '❌';
    default:
      return '📦';
  }
}

function OrderCard({
  order,
  darkMode,
  onPress,
}: {
  order: ReturnType<typeof useCartStore.getState>['orders'][0];
  darkMode: boolean;
  onPress: () => void;
}) {
  const firstItem = order.items[0];
  const moreCount = order.items.length - 1;
  const status = order.status as OrderStatus;

  return (
    <PressableScale
      style={[styles.orderCard, darkMode && styles.cardDark]}
      onPress={onPress}
      testID={`order-${order.id}`}
    >
      <View style={styles.orderHeader}>
        <View>
          <Text style={[styles.orderId, darkMode && styles.textLight]}>Order #{order.id.slice(0, 8)}</Text>
          <Text style={[styles.orderDate, darkMode && styles.subtitleDark]}>
            {new Date(order.date).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(status) + '20' }]}>
          <Text style={styles.statusIcon}>{getStatusIcon(status)}</Text>
          <Text style={[styles.statusText, { color: getStatusColor(status) }]}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </Text>
        </View>
      </View>

      <View style={styles.orderItems}>
        {firstItem && (
          <View style={styles.itemPreview}>
            <Image
              source={{ uri: firstItem.product.image }}
              style={styles.itemImage}
            />
            <View style={styles.itemInfo}>
              <Text style={[styles.itemName, darkMode && styles.textLight]} numberOfLines={1}>
                {firstItem.product.name}
              </Text>
              <Text style={[styles.itemQty, darkMode && styles.subtitleDark]}>
                Qty: {firstItem.quantity}
              </Text>
            </View>
          </View>
        )}
        {moreCount > 0 && (
          <Text style={[styles.moreItems, darkMode && styles.subtitleDark]}>
            +{moreCount} more item{moreCount > 1 ? 's' : ''}
          </Text>
        )}
      </View>

      <View style={styles.orderFooter}>
        <View>
          <Text style={[styles.totalLabel, darkMode && styles.subtitleDark]}>Total</Text>
          <Text style={styles.totalValue}>${order.total.toFixed(2)}</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>
    </PressableScale>
  );
}

function OrderDetails({
  order,
  darkMode,
  onClose,
}: {
  order: ReturnType<typeof useCartStore.getState>['orders'][0];
  darkMode: boolean;
  onClose: () => void;
}) {
  const status = order.status as OrderStatus;

  return (
    <View style={[styles.detailsOverlay]} testID="order-details">
      <View style={[styles.detailsContent, darkMode && styles.cardDark]}>
        <View style={styles.detailsHeader}>
          <Text style={[styles.detailsTitle, darkMode && styles.textLight]}>Order Details</Text>
          <PressableScale onPress={onClose} testID="close-details">
            <Text style={styles.closeBtn}>✕</Text>
          </PressableScale>
        </View>

        <View style={[styles.detailsSection]}>
          <Text style={[styles.detailsLabel, darkMode && styles.subtitleDark]}>Order ID</Text>
          <Text style={[styles.detailsValue, darkMode && styles.textLight]}>{order.id}</Text>
        </View>

        <View style={styles.detailsSection}>
          <Text style={[styles.detailsLabel, darkMode && styles.subtitleDark]}>Status</Text>
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(status) + '20' }]}>
            <Text style={styles.statusIcon}>{getStatusIcon(status)}</Text>
            <Text style={[styles.statusText, { color: getStatusColor(status) }]}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Text>
          </View>
        </View>

        <View style={styles.detailsSection}>
          <Text style={[styles.detailsLabel, darkMode && styles.subtitleDark]}>Shipping Address</Text>
          <Text style={[styles.detailsValue, darkMode && styles.textLight]}>{order.shippingAddress}</Text>
        </View>

        <View style={styles.detailsSection}>
          <Text style={[styles.detailsLabel, darkMode && styles.subtitleDark]}>Items</Text>
          {order.items.map(item => (
            <View key={item.product.id} style={styles.detailItem}>
              <Image source={{ uri: item.product.image }} style={styles.detailItemImage} />
              <View style={styles.detailItemInfo}>
                <Text style={[styles.detailItemName, darkMode && styles.textLight]} numberOfLines={1}>
                  {item.product.name}
                </Text>
                <Text style={[styles.detailItemMeta, darkMode && styles.subtitleDark]}>
                  ${item.product.price.toFixed(2)} × {item.quantity}
                </Text>
              </View>
              <Text style={styles.detailItemTotal}>
                ${(item.product.price * item.quantity).toFixed(2)}
              </Text>
            </View>
          ))}
        </View>

        <View style={[styles.detailsTotalSection, darkMode && { borderTopColor: '#2a2a3e' }]}>
          <Text style={[styles.detailsTotalLabel, darkMode && styles.textLight]}>Total</Text>
          <Text style={styles.detailsTotalValue}>${order.total.toFixed(2)}</Text>
        </View>

        <PressableScale
          style={styles.trackButton}
          onPress={onClose}
          testID="track-order"
        >
          <Text style={styles.trackButtonText}>Track Order</Text>
        </PressableScale>
      </View>
    </View>
  );
}

function EmptyOrders({ darkMode, onBrowse }: { darkMode: boolean; onBrowse: () => void }) {
  return (
    <View style={[styles.emptyContainer, darkMode && styles.containerDark]} testID="empty-orders">
      <Text style={styles.emptyIcon}>📦</Text>
      <Text style={[styles.emptyTitle, darkMode && styles.textLight]}>No orders yet</Text>
      <Text style={[styles.emptySubtitle, darkMode && styles.subtitleDark]}>
        Start shopping to see your orders here
      </Text>
      <PressableScale style={styles.browseButton} onPress={onBrowse} testID="browse-products">
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
  const [selectedOrder, setSelectedOrder] = useState<typeof orders[0] | null>(null);

  // Sort orders by date (newest first)
  const sortedOrders = [...orders].sort((a, b) =>
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  if (!isAuthenticated) {
    return (
      <>
        <Stack.Screen
          options={{
            title: 'Orders',
            headerStyle: { backgroundColor: darkMode ? '#1a1a2e' : '#ffffff' },
            headerTintColor: darkMode ? '#ffffff' : '#000000',
          }}
        />
        <View style={[styles.emptyContainer, darkMode && styles.containerDark]} testID="orders-guest">
          <Text style={styles.emptyIcon}>🔒</Text>
          <Text style={[styles.emptyTitle, darkMode && styles.textLight]}>Sign in to view orders</Text>
          <Text style={[styles.emptySubtitle, darkMode && styles.subtitleDark]}>
            You need to be signed in to view your order history
          </Text>
          <PressableScale
            style={styles.browseButton}
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
          headerStyle: { backgroundColor: darkMode ? '#1a1a2e' : '#ffffff' },
          headerTintColor: darkMode ? '#ffffff' : '#000000',
        }}
      />
      <View style={[styles.container, darkMode && styles.containerDark]} testID="orders-screen">
        {sortedOrders.length === 0 ? (
          <EmptyOrders darkMode={darkMode} onBrowse={() => router.push('/products')} />
        ) : (
          <>
            <View style={styles.header}>
              <Text style={[styles.headerTitle, darkMode && styles.textLight]}>
                {sortedOrders.length} Order{sortedOrders.length !== 1 ? 's' : ''}
              </Text>
            </View>
            <FlatList
              data={sortedOrders}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <OrderCard
                  order={item}
                  darkMode={darkMode}
                  onPress={() => setSelectedOrder(item)}
                />
              )}
              contentContainerStyle={styles.list}
              testID="orders-list"
            />
          </>
        )}

        {selectedOrder && (
          <OrderDetails
            order={selectedOrder}
            darkMode={darkMode}
            onClose={() => setSelectedOrder(null)}
          />
        )}
      </View>
    </>
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
    padding: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a2e',
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
  list: {
    padding: 16,
    paddingTop: 0,
  },
  orderCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  orderId: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  orderDate: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusIcon: {
    fontSize: 12,
    marginRight: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  orderItems: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 12,
    marginBottom: 12,
  },
  itemPreview: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemImage: {
    width: 50,
    height: 50,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  itemInfo: {
    flex: 1,
    marginLeft: 12,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1a1a2e',
  },
  itemQty: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  moreItems: {
    fontSize: 13,
    color: '#666',
    marginTop: 8,
    fontStyle: 'italic',
  },
  orderFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 12,
  },
  totalLabel: {
    fontSize: 12,
    color: '#666',
  },
  totalValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  chevron: {
    fontSize: 24,
    color: '#ccc',
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
  browseButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 14,
    borderRadius: 25,
  },
  browseButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  detailsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  detailsContent: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxHeight: '90%',
  },
  detailsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  detailsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  closeBtn: {
    fontSize: 24,
    color: '#999',
    padding: 4,
  },
  detailsSection: {
    marginBottom: 16,
  },
  detailsLabel: {
    fontSize: 12,
    color: '#666',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  detailsValue: {
    fontSize: 15,
    color: '#1a1a2e',
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  detailItemImage: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: '#f0f0f0',
  },
  detailItemInfo: {
    flex: 1,
    marginLeft: 10,
  },
  detailItemName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1a1a2e',
  },
  detailItemMeta: {
    fontSize: 12,
    color: '#666',
  },
  detailItemTotal: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  detailsTotalSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 16,
    marginTop: 8,
    marginBottom: 20,
  },
  detailsTotalLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  detailsTotalValue: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  trackButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  trackButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
