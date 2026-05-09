import { Stack } from 'expo-router';

export default function HomeLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="index" options={{ headerTitle: 'Home' }} />
    </Stack>
  );
}
