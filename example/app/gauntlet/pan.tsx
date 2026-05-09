// RNGH Pan gesture — drag a box around. Validates Ennio doesn't break
// pan-driven elements (it shouldn't tap them, but should be able to
// query their position and assert visibility).

import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { View, Text, StyleSheet } from 'react-native';
import { useState } from 'react';
import { PressableScale } from 'pressto';

export default function PanScreen() {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const [resetCount, setResetCount] = useState(0);

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((e) => {
      x.value = startX.value + e.translationX;
      y.value = startY.value + e.translationY;
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.container} testID="pan-screen">
        <Text style={styles.title}>Pan gesture (drag the box)</Text>
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.box, style]} testID="pan-box">
            <Text style={styles.boxLabel}>Drag me</Text>
          </Animated.View>
        </GestureDetector>
        <PressableScale
          testID="pan-reset"
          style={styles.button}
          onPress={() => {
            x.value = withSpring(0);
            y.value = withSpring(0);
            setResetCount((c) => c + 1);
          }}
        >
          <Text style={styles.buttonText}>Reset</Text>
        </PressableScale>
        <Text testID="pan-reset-count" style={styles.counter}>
          Resets: {resetCount}
        </Text>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 18, marginBottom: 24, textAlign: 'center' },
  box: {
    width: 100,
    height: 100,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxLabel: { color: '#fff', fontWeight: '600' },
  button: {
    backgroundColor: '#FF3B30',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 32,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  counter: { textAlign: 'center', marginTop: 12 },
});
