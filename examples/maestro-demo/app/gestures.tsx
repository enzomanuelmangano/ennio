import { Stack, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's gestures screen: tap-to-green squares laid out so a
// single swipe can hit them in sequence, plus double-tap / long-press / "End here!"
// targets. Squares start RED and turn GREEN on press; once all three are green and
// "End here!" was tapped, "All green" appears.
export default function GesturesScreen() {
  const router = useRouter();
  const [greens, setGreens] = useState<[boolean, boolean, boolean]>([
    false,
    false,
    false,
  ]);
  const [finished, setFinished] = useState(false);
  const [doubleTapped, setDoubleTapped] = useState(false);
  const [longPressed, setLongPressed] = useState(false);

  const lastTapRef = useRef(0);

  const turnGreen = useCallback((index: 0 | 1 | 2) => {
    setGreens((prev) => {
      if (prev[index]) {
        return prev;
      }
      const next: [boolean, boolean, boolean] = [...prev];
      next[index] = true;
      return next;
    });
  }, []);

  const onDoubleTapPress = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setDoubleTapped(true);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }, []);

  const allGreen = greens[0] && greens[1] && greens[2];

  return (
    <SafeAreaView style={styles.flex}>
      <Stack.Screen options={{ headerShown: false }} />

      <Pressable
        style={styles.backButton}
        testID="back"
        accessibilityLabel="Back"
        onPress={() => router.back()}
      >
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      {([0, 1, 2] as const).map((index) => (
        <Pressable
          key={index}
          style={[
            styles.square,
            squarePositions[index],
            { backgroundColor: greens[index] ? '#2e7d32' : '#c62828' },
          ]}
          testID={`Container ${index}`}
          accessibilityLabel={`Container ${index}`}
          onPress={() => turnGreen(index)}
          onPressIn={() => turnGreen(index)}
        />
      ))}

      <Pressable
        style={styles.endHere}
        testID="end-here"
        accessibilityLabel="End here!"
        onPress={() => setFinished(true)}
      >
        <Text style={styles.endHereText}>End here!</Text>
      </Pressable>

      {allGreen && finished && (
        <View style={styles.allGreenWrap} pointerEvents="none">
          <Text style={styles.allGreenText}>All green</Text>
        </View>
      )}

      <Pressable
        style={styles.doubleTap}
        testID="double-tap"
        accessibilityLabel="Double tap me"
        onPress={onDoubleTapPress}
      >
        <Text style={styles.boxText}>Double tap me</Text>
      </Pressable>
      {doubleTapped && <Text style={styles.doubleTapResult}>Double tapped!</Text>}

      <Pressable
        style={styles.longPress}
        testID="long-press"
        accessibilityLabel="Long press me"
        onLongPress={() => setLongPressed(true)}
      >
        <Text style={styles.boxText}>Long press me</Text>
      </Pressable>
      {longPressed && <Text style={styles.longPressResult}>Long pressed!</Text>}
    </SafeAreaView>
  );
}

const SQUARE = 100;

const squarePositions: ViewStyle[] = [
  // Container 0: top ~15%, horizontally centered.
  { top: '15%', left: '50%', marginLeft: -SQUARE / 2 },
  // Container 1: vertically centered, ~15% from left.
  { top: '50%', marginTop: -SQUARE / 2, left: '15%' },
  // Container 2: near bottom-right (~85%, ~85%).
  { top: '85%', marginTop: -SQUARE / 2, left: '85%', marginLeft: -SQUARE / 2 },
];

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  backButton: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backText: { fontSize: 16, color: '#1565c0', fontWeight: '600' },
  square: {
    position: 'absolute',
    width: SQUARE,
    height: SQUARE,
    borderRadius: 8,
    borderCurve: 'continuous',
  },
  endHere: {
    position: 'absolute',
    top: '50%',
    left: '85%',
    width: 80,
    height: 80,
    marginTop: -40,
    marginLeft: -40,
    backgroundColor: '#9e9e9e',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  endHereText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  allGreenWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allGreenText: { fontSize: 32, fontWeight: '700', color: '#2e7d32' },
  doubleTap: {
    position: 'absolute',
    top: '28%',
    left: '50%',
    width: 160,
    marginLeft: -80,
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingVertical: 16,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  doubleTapResult: {
    position: 'absolute',
    top: '36%',
    alignSelf: 'center',
    fontSize: 16,
    fontWeight: '600',
    color: '#1565c0',
  },
  longPress: {
    position: 'absolute',
    top: '62%',
    left: '50%',
    width: 160,
    marginLeft: -80,
    backgroundColor: '#6a1b9a',
    borderRadius: 8,
    paddingVertical: 16,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  longPressResult: {
    position: 'absolute',
    top: '70%',
    alignSelf: 'center',
    fontSize: 16,
    fontWeight: '600',
    color: '#6a1b9a',
  },
  boxText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
});
