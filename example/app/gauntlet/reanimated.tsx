// Reanimated worklet button — onPress runs a worklet animation, plus a
// JS callback. Validates that Ennio still triggers JS handlers on
// reanimated-wrapped Pressables.

import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function ReanimatedScreen() {
  const scale = useSharedValue(1);
  const [count, setCount] = useState(0);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={styles.container} testID="reanimated-screen">
      <Text style={styles.title}>Reanimated worklet button</Text>
      <Text style={styles.count} testID="reanimated-count">
        Pressed: {count}
      </Text>
      <Animated.View style={[styles.box, style]}>
        <PressableScale
          testID="reanimated-button"
          style={styles.button}
          onPress={() => {
            scale.value = withSpring(scale.value === 1 ? 1.2 : 1);
            setCount((c) => c + 1);
          }}
        >
          <Text style={styles.buttonText}>Pulse + count</Text>
        </PressableScale>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 24 },
  count: { fontSize: 28, fontWeight: '700', marginBottom: 32 },
  box: { padding: 8 },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 12,
  },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
