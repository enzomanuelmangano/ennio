import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { useCartStore } from '../../store';

// JS-rendered Tabs from expo-router. Renders Pressable buttons that show
// up in the Fabric shadow tree → ennio can find by text/testID and tap
// via idb's coord injection. NativeTabs renders to UITabBar, which
// doesn't expose its items to React or to the simulator's accessibility
// tree, so we'd lose tap-by-label there.
export default function TabLayout() {
  const cartItemCount = useCartStore(state => state.getItemCount());

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#007AFF',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarTestID: 'tab-home',
          tabBarIcon: ({ color }) => <Icon icon="🏠" color={color} />,
        }}
      />
      <Tabs.Screen
        name="products"
        options={{
          title: 'Products',
          tabBarTestID: 'tab-products',
          tabBarIcon: ({ color }) => <Icon icon="🛍" color={color} />,
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: 'Cart',
          tabBarTestID: 'tab-cart',
          tabBarBadge: cartItemCount > 0 ? cartItemCount : undefined,
          tabBarIcon: ({ color }) => <Icon icon="🛒" color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarTestID: 'tab-profile',
          tabBarIcon: ({ color }) => <Icon icon="👤" color={color} />,
        }}
      />
    </Tabs>
  );
}

function Icon({ icon, color }: { icon: string; color: string }) {
  return (
    <View>
      <Text style={{ fontSize: 22, color }}>{icon}</Text>
    </View>
  );
}
