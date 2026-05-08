// Deep link target — opened via openLink from a yaml flow.
// `app://gauntlet/deep-link` lands here. Just renders a marker for
// assertVisible.

import { View, Text, StyleSheet } from 'react-native';

export default function DeepLinkScreen() {
  return (
    <View style={styles.container} testID="deep-link-screen">
      <Text style={styles.title}>Deep link target</Text>
      <Text style={styles.marker} testID="deep-link-marker">
        Reached via openLink
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  marker: { fontSize: 18, color: '#34C759' },
});
