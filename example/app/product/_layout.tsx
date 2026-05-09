import { Stack } from 'expo-router';

export default function ProductLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="[id]" />
    </Stack>
  );
}
