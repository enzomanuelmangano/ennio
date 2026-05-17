// Native UISegmentedControl via
// @react-native-segmented-control/segmented-control. Validates
// Ennio can drive a UIControl that fires onChange via target/action
// rather than a UIPickerViewDelegate.

import { useState } from 'react';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import { View, Text, StyleSheet } from 'react-native';

const VALUES = ['Day', 'Week', 'Month'];

export default function SegmentedScreen() {
  const [index, setIndex] = useState(0);

  return (
    <View style={styles.container} testID="segmented-screen">
      <Text style={styles.title}>Segmented control</Text>
      <Text style={styles.value} testID="segmented-value">
        Selected: {VALUES[index]}
      </Text>
      <SegmentedControl
        testID="segmented-control"
        values={VALUES}
        selectedIndex={index}
        onChange={(e) => setIndex(e.nativeEvent.selectedSegmentIndex)}
        style={styles.control}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  value: { fontSize: 18, marginVertical: 24, textAlign: 'center', color: '#34C759' },
  control: { marginVertical: 12 },
});
