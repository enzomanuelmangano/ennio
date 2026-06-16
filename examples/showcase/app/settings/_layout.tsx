import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
        // See orders/_layout.tsx: RNScreens full-screen edge swipe reliably
        // pops the stack when Maestro fires its synthesized swipe.
        fullScreenGestureEnabled: true,
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}
