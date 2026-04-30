import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TastoProvider } from '@tasto/app';
import { useSettingsStore } from '../store';

export default function RootLayout() {
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <TastoProvider>
      <StatusBar style={darkMode ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: darkMode ? '#1a1a2e' : '#ffffff',
          },
          headerTintColor: darkMode ? '#ffffff' : '#000000',
          contentStyle: {
            backgroundColor: darkMode ? '#16213e' : '#f5f5f5',
          },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="auth/login"
          options={{
            title: 'Sign In',
            presentation: 'modal',
          }}
        />
        <Stack.Screen
          name="auth/register"
          options={{
            title: 'Create Account',
            presentation: 'modal',
          }}
        />
        <Stack.Screen
          name="product/[id]"
          options={{
            title: 'Product Details',
          }}
        />
        <Stack.Screen
          name="checkout"
          options={{
            title: 'Checkout',
            presentation: 'modal',
          }}
        />
        <Stack.Screen
          name="orders"
          options={{
            title: 'Order History',
          }}
        />
        <Stack.Screen
          name="settings"
          options={{
            title: 'Settings',
          }}
        />
      </Stack>
    </TastoProvider>
  );
}
