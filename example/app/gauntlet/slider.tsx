import Slider from '@react-native-community/slider';
import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function SliderScreen() {
  const [value, setValue] = useState(0.5);
  const [committed, setCommitted] = useState<number | null>(null);

  return (
    <View style={styles.container} testID="slider-screen">
      <Text style={styles.title}>Slider test</Text>
      <Text style={styles.value} testID="slider-value">
        {value.toFixed(2)}
      </Text>
      <Slider
        testID="slider-control"
        style={{ width: '100%', height: 40 }}
        minimumValue={0}
        maximumValue={1}
        value={value}
        onValueChange={setValue}
        onSlidingComplete={setCommitted}
      />
      <PressableScale testID="slider-set-half" style={styles.button} onPress={() => setValue(0.5)}>
        <Text style={styles.buttonText}>Reset to 0.50</Text>
      </PressableScale>
      {committed !== null && (
        <Text style={styles.committed} testID="slider-committed">
          Committed: {committed.toFixed(2)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  value: { fontSize: 36, fontWeight: '700', textAlign: 'center', marginVertical: 24 },
  button: {
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  committed: { marginTop: 16, color: '#34C759', textAlign: 'center' },
});
