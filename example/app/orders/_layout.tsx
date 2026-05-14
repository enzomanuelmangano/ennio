import { Stack } from 'expo-router';

export default function OrdersLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
        // Edge-swipe from anywhere on the screen pops the stack (RNScreens).
        // Default edge-only gesture doesn't always fire from Maestro's
        // simulated swipe; the full-screen variant lands reliably.
        fullScreenGestureEnabled: true,
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}
