import { Stack } from 'expo-router';

export default function CartLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ headerTitle: 'Cart' }} />
    </Stack>
  );
}
