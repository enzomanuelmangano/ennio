import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PressablesConfig } from 'pressto';
import { useSettingsStore } from '../store';

// Ignore Ennio's synthetic touch warnings (taps still work, this is just a RN internal warning)
LogBox.ignoreLogs(['Cannot find single active touch']);

export default function RootLayout() {
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <PressablesConfig>
      <StatusBar style={darkMode ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerLargeTitleShadowVisible: false,
          headerShadowVisible: false,
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
        <Stack.Screen name="product" options={{ headerShown: false }} />
        <Stack.Screen
          name="checkout"
          options={{
            title: 'Checkout',
            presentation: 'modal',
          }}
        />
        <Stack.Screen name="orders" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen
          name="gauntlet/sheet-form"
          options={{ presentation: 'formSheet', title: 'formSheet' }}
        />
        <Stack.Screen
          name="gauntlet/sheet-page"
          options={{ presentation: 'pageSheet', title: 'pageSheet' }}
        />
        <Stack.Screen
          name="gauntlet/sheet-stacked"
          options={{ presentation: 'modal', title: 'Stacked modal' }}
        />
        <Stack.Screen
          name="gauntlet/sheet-transparent"
          options={{ presentation: 'transparentModal', headerShown: false, animation: 'fade' }}
        />
      </Stack>
      </PressablesConfig>
    </GestureHandlerRootView>
  );
}
