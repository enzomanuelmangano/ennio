import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

// Mirrors Maestro demo_app's cropped-screenshot fixture: a pixel-stable
// arrangement of fixed-size coloured shapes used to validate screenshot crops.
// Colours and sizes are intentionally constant (no animation).
export default function CroppedScreenshotScreen() {
  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: 'Cropped Screenshot Test' }} />
      <View style={styles.center}>
        <View testID="testContainer" accessibilityLabel="testContainer" style={styles.container}>
          <View style={styles.red} />
          <View style={styles.blue} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: {
    width: 240,
    height: 180,
    backgroundColor: '#F0F0F0',
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderCurve: 'continuous',
  },
  red: {
    width: 96,
    height: 96,
    backgroundColor: '#FF0000',
  },
  blue: {
    width: 192,
    height: 48,
    backgroundColor: '#0000FF',
  },
});
