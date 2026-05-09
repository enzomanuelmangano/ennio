import { useState } from 'react';
import { View, Text, TextInput, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function KeyboardAvoidingScreen() {
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      testID="keyboard-screen"
    >
      <View style={styles.spacer} />
      <View style={styles.bottom}>
        <TextInput
          testID="keyboard-input"
          style={styles.input}
          placeholder="Type and submit"
          value={value}
          onChangeText={setValue}
        />
        <PressableScale
          testID="keyboard-submit"
          style={styles.button}
          onPress={() => setSubmitted(value)}
        >
          <Text style={styles.buttonText}>Submit</Text>
        </PressableScale>
        {submitted !== null && (
          <Text style={styles.submitted} testID="keyboard-submitted">
            Submitted: {submitted}
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  spacer: { flex: 1 },
  bottom: { padding: 20, gap: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 10, padding: 12,
  borderCurve: 'continuous' },
  button: { backgroundColor: '#007AFF', padding: 14, borderRadius: 10, alignItems: 'center',
  borderCurve: 'continuous' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  submitted: { color: '#34C759' },
});
