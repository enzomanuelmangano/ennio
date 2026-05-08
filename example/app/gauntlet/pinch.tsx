// RNGH Pinch gesture — scale a box. Same role as pan: validate Ennio
// can co-exist with multitouch gestures, even if it can't drive them.

import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { View, Text, StyleSheet } from 'react-native';
import { useState } from 'react';
import { PressableScale } from 'pressto';

export default function PinchScreen() {
  const scale = useSharedValue(1);
  const start = useSharedValue(1);
  const [resetCount, setResetCount] = useState(0);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      start.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = start.value * e.scale;
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.container} testID="pinch-screen">
        <Text style={styles.title}>Pinch gesture (use two fingers)</Text>
        <GestureDetector gesture={pinch}>
          <Animated.View style={[styles.box, style]} testID="pinch-box">
            <Text style={styles.boxLabel}>Pinch me</Text>
          </Animated.View>
        </GestureDetector>
        <PressableScale
          testID="pinch-reset"
          style={styles.button}
          onPress={() => {
            scale.value = withSpring(1);
            setResetCount((c) => c + 1);
          }}
        >
          <Text style={styles.buttonText}>Reset</Text>
        </PressableScale>
        <Text testID="pinch-reset-count" style={styles.counter}>
          Resets: {resetCount}
        </Text>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, alignItems: 'center' },
  title: { fontSize: 18, marginBottom: 32, textAlign: 'center' },
  box: { width: 120, height: 120, backgroundColor: '#FF9500', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  boxLabel: { color: '#fff', fontWeight: '600' },
  button: { backgroundColor: '#FF3B30', padding: 14, borderRadius: 10, marginTop: 48, paddingHorizontal: 32 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  counter: { marginTop: 12 },
});
