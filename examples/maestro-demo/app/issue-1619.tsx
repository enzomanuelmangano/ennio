import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro issue 1619 repro: two stacked Texts with stable testIDs.
export default function Issue1619Screen() {
  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'issue 1619 repro' }} />
      <View style={styles.content}>
        <Text testID="first" accessibilityLabel="first" style={styles.label}>
          First
        </Text>
        <Text testID="second" accessibilityLabel="second" style={styles.label}>
          Second
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, gap: 16 },
  label: { fontSize: 20 },
});
