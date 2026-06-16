import { Stack } from 'expo-router';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

// Mirrors Maestro demo_app's defects screen: overlapping/occluding elements
// that stress element disambiguation. A placeholder image box has text laid
// over it, and five partially-overlapping corner buttons make hit-testing
// non-trivial.
const LOREM_LINE_1 = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
const LOREM_LINE_2 = 'Sed do eiusmod tempor incididunt ut labore et dolore.';

type ButtonSpec = {
  testID: string;
  letter: string;
  text: string;
  style: StyleProp<ViewStyle>;
};

const BUTTONS: ButtonSpec[] = [
  { testID: 'do-thing-a', letter: 'A', text: 'Do thing A', style: { top: 0, left: 0 } },
  { testID: 'do-thing-b', letter: 'B', text: 'Do thing B', style: { top: 0, right: 0 } },
  { testID: 'do-thing-x', letter: 'X', text: 'Do thing X', style: { bottom: 0, left: 0 } },
  { testID: 'do-thing-y', letter: 'Y', text: 'Do thing Y', style: { bottom: 0, right: 0 } },
  {
    testID: 'do-thing-z',
    letter: 'Z',
    text: 'Do thing Z',
    style: { top: '50%', left: '50%' },
  },
];

export default function DefectsScreen() {
  const [tapped, setTapped] = useState<string | null>(null);

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: 'Defects test screen' }} />

      <View style={styles.stack}>
        <View style={styles.imagePlaceholder} />
        <View style={styles.overlayText}>
          <Text style={styles.loremText}>{LOREM_LINE_1}</Text>
          <Text style={styles.loremText}>{LOREM_LINE_2}</Text>
        </View>

        {BUTTONS.map((b) => (
          <Pressable
            key={b.testID}
            testID={b.testID}
            accessibilityLabel={b.text}
            style={[styles.button, b.style]}
            onPress={() => setTapped(b.letter)}
          >
            <Text style={styles.buttonText}>{b.text}</Text>
          </Pressable>
        ))}
      </View>

      {tapped !== null && (
        <Text style={styles.result}>{`Tapped ${tapped}`}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  stack: {
    width: 300,
    height: 300,
    alignSelf: 'center',
    marginTop: 40,
  },
  imagePlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#90a4ae',
  },
  overlayText: {
    position: 'absolute',
    top: 120,
    left: 16,
    right: 16,
    gap: 4,
  },
  loremText: { fontSize: 14, color: '#ffffff' },
  button: {
    position: 'absolute',
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderCurve: 'continuous',
  },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  result: {
    textAlign: 'center',
    marginTop: 24,
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
  },
});
