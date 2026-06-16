import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

// Mirrors Maestro demo_app's webview screen: a full-screen WebView pointing at
// saucedemo.com. Flows assert the page text "Swag Labs" becomes visible.
export default function WebViewScreen() {
  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Example WebView' }} />
      <WebView
        testID="example-webview"
        style={styles.flex}
        source={{ uri: 'https://www.saucedemo.com/' }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
});
