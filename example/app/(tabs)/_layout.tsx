import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Stack } from 'expo-router';
import { useCartStore } from '../../store';

export default function TabLayout() {
  const cartItemCount = useCartStore((state) => state.getItemCount());

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <NativeTabs tintColor="#007AFF">
        <NativeTabs.Trigger name="(home)" testID="tab-home">
          <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{
              default: 'house',
              selected: 'house.fill',
            }}
            md="home"
          />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(products)" testID="tab-products">
          <NativeTabs.Trigger.Label>Products</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{
              default: 'bag',
              selected: 'bag.fill',
            }}
            md="shopping_bag"
          />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(cart)" testID="tab-cart">
          <NativeTabs.Trigger.Label>Cart</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{
              default: 'cart',
              selected: 'cart.fill',
            }}
            md="shopping_cart"
          />
          {cartItemCount > 0 && (
            <NativeTabs.Trigger.Badge>{String(cartItemCount)}</NativeTabs.Trigger.Badge>
          )}
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(profile)" testID="tab-profile">
          <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{
              default: 'person',
              selected: 'person.fill',
            }}
            md="person"
          />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(gauntlet)" testID="tab-gauntlet">
          <NativeTabs.Trigger.Label>Gauntlet</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{
              default: 'wand.and.stars',
              selected: 'wand.and.stars.inverse',
            }}
            md="science"
          />
        </NativeTabs.Trigger>
      </NativeTabs>
    </>
  );
}
