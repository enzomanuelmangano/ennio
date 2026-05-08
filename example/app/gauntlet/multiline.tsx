import { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';

export default function MultilineScreen() {
  const [value, setValue] = useState('');
  return (
    <View style={styles.container} testID="multiline-screen">
      <Text style={styles.title}>Multi-line TextInput</Text>
      <TextInput
        testID="multiline-input"
        style={styles.input}
        multiline
        numberOfLines={6}
        placeholder="Type a few lines..."
        value={value}
        onChangeText={setValue}
        textAlignVertical="top"
      />
      <Text style={styles.count} testID="multiline-count">
        {value.length} chars
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 10, padding: 12, minHeight: 140 },
  count: { marginTop: 12, color: '#666' },
});
