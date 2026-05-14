import { WebView } from 'react-native-webview';
import { View, Text, StyleSheet } from 'react-native';
import { useState } from 'react';

export default function WebViewScreen() {
  const [loaded, setLoaded] = useState(false);
  return (
    <View style={styles.container} testID="webview-screen">
      <Text style={styles.title}>WebView test</Text>
      <View style={{ flex: 1 }}>
        <WebView
          testID="webview-container"
          source={{ html: '<html><body><h1 id="webview-h">Hello WebView</h1></body></html>' }}
          onLoadEnd={() => setLoaded(true)}
        />
      </View>
      {loaded && (
        <Text style={styles.loaded} testID="webview-loaded-marker">
          Loaded
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingBottom: 60 },
  title: { fontSize: 22, fontWeight: '600', padding: 16 },
  loaded: { padding: 12, color: '#34C759', textAlign: 'center' },
});
