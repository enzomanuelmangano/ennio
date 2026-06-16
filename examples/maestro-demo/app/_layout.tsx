import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Ennio's synthetic touch injection trips a benign RN internal warning.
LogBox.ignoreLogs(['Cannot find single active touch']);

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          contentStyle: { backgroundColor: '#ffffff' },
        }}
      />
    </GestureHandlerRootView>
  );
}
