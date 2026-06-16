import { Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro issue 1677 repro: tapping the parent OR its nested child Text
// increments the counter. The child keeps its own testID so it stays
// independently discoverable in the view hierarchy.
export default function Issue1677Screen() {
  const [count, setCount] = useState(0);

  const increment = () => setCount((c) => c + 1);

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'issue 1677 repro' }} />
      <View style={styles.content}>
        <Text style={styles.count}>{`tap count: ${count}`}</Text>
        <Pressable
          testID="parent_ident"
          accessibilityLabel="parent_ident"
          style={styles.parent}
          onPress={increment}
        >
          <Text
            testID="child_ident"
            accessibilityLabel="child_ident"
            style={styles.child}
            onPress={increment}
          >
            press me
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, gap: 24, alignItems: 'center' },
  count: { fontSize: 20, fontWeight: '600' },
  parent: {
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingHorizontal: 32,
    paddingVertical: 24,
    borderCurve: 'continuous',
  },
  child: { color: '#ffffff', fontSize: 18 },
});
