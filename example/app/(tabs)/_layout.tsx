import { Tabs } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { useCartStore, useSettingsStore } from '../../store';

function TabIcon({ name, focused, badge }: { name: string; focused: boolean; badge?: number }) {
  const icons: Record<string, string> = {
    home: focused ? '🏠' : '🏡',
    products: focused ? '🛍️' : '🛒',
    cart: focused ? '🛒' : '🧺',
    profile: focused ? '👤' : '👥',
  };

  return (
    <View style={styles.iconContainer} testID={`tab-${name}`}>
      <Text style={styles.icon}>{icons[name] || '📦'}</Text>
      {badge !== undefined && badge > 0 && (
        <View style={styles.badge} testID={`${name}-badge`}>
          <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      )}
    </View>
  );
}

export default function TabLayout() {
  const cartItemCount = useCartStore(state => state.getItemCount());
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#007AFF',
        tabBarInactiveTintColor: darkMode ? '#888' : '#666',
        tabBarStyle: {
          backgroundColor: darkMode ? '#1a1a2e' : '#ffffff',
          borderTopColor: darkMode ? '#2a2a3e' : '#e0e0e0',
        },
        headerStyle: {
          backgroundColor: darkMode ? '#1a1a2e' : '#ffffff',
        },
        headerTintColor: darkMode ? '#ffffff' : '#000000',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => <TabIcon name="home" focused={focused} />,
          tabBarAccessibilityLabel: 'tab-home',
        }}
      />
      <Tabs.Screen
        name="products"
        options={{
          title: 'Products',
          tabBarIcon: ({ focused }) => <TabIcon name="products" focused={focused} />,
          tabBarAccessibilityLabel: 'tab-products',
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: 'Cart',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="cart" focused={focused} badge={cartItemCount} />
          ),
          tabBarAccessibilityLabel: 'tab-cart',
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => <TabIcon name="profile" focused={focused} />,
          tabBarAccessibilityLabel: 'tab-profile',
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconContainer: {
    position: 'relative',
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 20,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: '#FF3B30',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
});
