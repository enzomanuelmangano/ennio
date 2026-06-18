import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's animation screen: a countdown that updates the
// on-screen text continuously, which is what `waitForAnimationToEnd` polls. The
// timer text ends exactly at "0.0s" so flows can assert it.
const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

export default function AnimationScreen() {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [phaseIndex, setPhaseIndex] = useState(0);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endTimeRef = useRef(0);

  const stopTimer = () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const start = (durationSeconds: number) => {
    stopTimer();
    endTimeRef.current = Date.now() + durationSeconds * 1000;
    setSeconds(durationSeconds);
    setPhaseIndex(0);

    intervalRef.current = setInterval(() => {
      const remainingMs = endTimeRef.current - Date.now();
      if (remainingMs <= 0) {
        setSeconds(0);
        stopTimer();
        return;
      }
      setSeconds(remainingMs / 1000);
      setPhaseIndex((prev) => (prev + 1) % MOON_PHASES.length);
    }, 50);
  };

  useEffect(() => stopTimer, []);

  const animating = seconds !== null && seconds > 0;

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Animation Test' }} />
      <View style={styles.content}>
        <Pressable
          style={styles.button}
          testID="animate-4s"
          accessibilityLabel="Animate (4s)"
          onPress={() => start(4)}
        >
          <Text style={styles.buttonText}>Animate (4s)</Text>
        </Pressable>
        <Pressable
          style={styles.button}
          testID="animate-30s"
          accessibilityLabel="Animate (30s)"
          onPress={() => start(30)}
        >
          <Text style={styles.buttonText}>Animate (30s)</Text>
        </Pressable>

        {seconds !== null && (
          <Text style={styles.timer} testID="timer" accessibilityLabel="Timer">
            {`${seconds.toFixed(1)}s`}
          </Text>
        )}

        <Text style={styles.moons}>
          {animating
            ? MOON_PHASES.map((_, i) => MOON_PHASES[(i + phaseIndex) % MOON_PHASES.length]).join('')
            : MOON_PHASES.join('')}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, gap: 16, alignItems: 'center' },
  button: {
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    alignSelf: 'stretch',
    borderCurve: 'continuous',
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  timer: { fontSize: 56, fontWeight: '700', color: '#212121', marginTop: 24 },
  moons: { fontSize: 28, letterSpacing: 2 },
});
