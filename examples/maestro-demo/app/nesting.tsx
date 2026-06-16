import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

// Mirrors Maestro demo_app's nesting screen. A level-0 container sits in the
// centre with three nested containers; four edge labels around it drive the
// relative-selector assertions (leftOf / rightOf / above / below).
export default function NestingScreen() {
  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: 'Nesting test screen' }} />

      <Text style={styles.leftSide}>left side</Text>
      <Text style={styles.topSide}>top side</Text>
      <Text style={styles.rightSide}>right side</Text>
      <Text style={styles.bottomSide}>bottom side</Text>

      <View style={styles.center}>
        <View testID="level-0" accessibilityLabel="level-0" style={styles.level0}>
          <Text style={styles.label}>Container at level 0</Text>
          <View testID="level-1" accessibilityLabel="level-1" style={styles.level1}>
            <Text style={styles.label}>Container at level 1</Text>
            <View testID="level-2" accessibilityLabel="level-2" style={styles.level2}>
              <Text style={styles.label}>Container at level 2</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  level0: {
    padding: 16,
    backgroundColor: '#e0e0e0',
    borderWidth: 1,
    borderColor: '#9e9e9e',
    alignItems: 'center',
  },
  level1: {
    marginTop: 8,
    padding: 16,
    backgroundColor: '#2196f3',
    alignItems: 'center',
  },
  level2: {
    marginTop: 8,
    padding: 16,
    backgroundColor: '#ff9800',
    alignItems: 'center',
  },
  label: { fontSize: 14, color: '#000000' },
  leftSide: {
    position: 'absolute',
    left: 8,
    top: '50%',
    fontSize: 16,
  },
  topSide: {
    position: 'absolute',
    top: 8,
    left: '50%',
    fontSize: 16,
  },
  rightSide: {
    position: 'absolute',
    right: 8,
    top: '50%',
    fontSize: 16,
  },
  bottomSide: {
    position: 'absolute',
    bottom: 8,
    left: '50%',
    fontSize: 16,
  },
});
