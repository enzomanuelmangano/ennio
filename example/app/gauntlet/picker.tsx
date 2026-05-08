import { Picker } from '@react-native-picker/picker';
import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function PickerScreen() {
  const [value, setValue] = useState<string>('apple');
  return (
    <View style={styles.container} testID="picker-screen">
      <Text style={styles.title}>Picker test</Text>
      <Text style={styles.value} testID="picker-value">
        Selected: {value}
      </Text>
      <Picker
        testID="picker-control"
        selectedValue={value}
        onValueChange={(v) => setValue(String(v))}
      >
        <Picker.Item label="Apple" value="apple" />
        <Picker.Item label="Banana" value="banana" />
        <Picker.Item label="Cherry" value="cherry" />
      </Picker>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  value: { fontSize: 18, marginVertical: 24, textAlign: 'center' },
});
