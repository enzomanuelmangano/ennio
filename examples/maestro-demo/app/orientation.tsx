import { Stack } from 'expo-router';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

// Mirrors Maestro demo_app's orientation screen. Only width/height are
// available, so we distinguish portrait vs landscape and default to the
// canonical "Landscape Left" / "Portrait" labels.
export default function OrientationScreen() {
  const { width, height } = useWindowDimensions();
  const orientation = width > height ? 'Landscape Left' : 'Portrait';

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: 'Orientation Test' }} />
      <View style={styles.center}>
        <Text
          testID="orientationLabel"
          accessibilityLabel="orientationLabel"
          style={styles.label}
        >
          {orientation}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 28, fontWeight: '600', color: '#000000' },
});
