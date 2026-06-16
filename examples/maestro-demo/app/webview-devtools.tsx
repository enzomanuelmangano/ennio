import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

// Mirrors Maestro demo_app's WebView devtools regression screen: an inline HTML
// page containing a visible heading and a hidden marker div used to verify that
// WebView devtools / DOM inspection can reach into the rendered document.
const HTML = `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        font-family: -apple-system, system-ui, sans-serif;
        margin: 24px;
        color: #212121;
      }
      #devtools-regression-marker {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
    </style>
  </head>
  <body>
    <h1>WebView Devtools Test</h1>
    <p>This page is used to verify WebView devtools regressions.</p>
    <div id="devtools-regression-marker" aria-hidden="true">marker</div>
  </body>
</html>`;

export default function WebViewDevtoolsScreen() {
  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'WebView Devtools Test' }} />
      <WebView testID="devtools-webview" style={styles.flex} source={{ html: HTML }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
});
