import { Stack } from 'expo-router';

export default function ProfileLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="index" options={{ headerTitle: 'Profile' }} />
    </Stack>
  );
}
