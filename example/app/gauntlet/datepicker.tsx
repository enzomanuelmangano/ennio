// Native UIDatePicker via @react-native-community/datetimepicker.
// Spinner mode renders a UIPickerView under the hood with separate
// month/day/year components; compact mode hosts a popover. Validates
// Ennio can drive both via selectPickerValueByLabel + a value
// echo for assertions.

import { useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { View, Text, StyleSheet, Platform } from 'react-native';

function fmt(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function DatePickerScreen() {
  const [value, setValue] = useState(new Date(2026, 0, 15));

  const onChange = (_e: DateTimePickerEvent, selected?: Date) => {
    if (selected) setValue(selected);
  };

  return (
    <View style={styles.container} testID="datepicker-screen">
      <Text style={styles.title}>Date picker (spinner)</Text>
      <Text style={styles.value} testID="datepicker-value">
        Date: {fmt(value)}
      </Text>
      <DateTimePicker
        testID="datepicker-control"
        value={value}
        mode="date"
        display={Platform.OS === 'ios' ? 'spinner' : 'default'}
        onChange={onChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  value: { fontSize: 18, marginVertical: 16, textAlign: 'center', color: '#34C759' },
});
