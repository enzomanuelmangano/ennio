import { Stack } from 'expo-router';

export default function ProfileLayout() {
  // headerLargeTitle disabled: when expanded it overlays the first
  // menu item visually, and any `tapOn` at the obscured row's centre
  // dispatches into the title view instead of the row. Plain header
  // keeps the row reachable.
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ headerTitle: 'Profile' }} />
    </Stack>
  );
}
