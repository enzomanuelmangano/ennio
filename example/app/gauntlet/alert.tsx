// Alert variants — single-button, two-button, three-button, prompt.
// Validates Ennio's tapAlertButton against each shape.

import { useState } from 'react';
import { View, Text, Alert, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function AlertScreen() {
  const [last, setLast] = useState<string | null>(null);

  return (
    <View style={styles.container} testID="alert-screen">
      <Text style={styles.title}>Alert variants</Text>

      <PressableScale
        testID="alert-single"
        style={styles.button}
        onPress={() =>
          Alert.alert('Single', 'One button alert', [
            { text: 'OK', onPress: () => setLast('single-ok') },
          ])
        }
      >
        <Text style={styles.buttonText}>Single-button alert</Text>
      </PressableScale>

      <PressableScale
        testID="alert-two"
        style={styles.button}
        onPress={() =>
          Alert.alert('Two', 'Two button alert', [
            { text: 'Cancel', style: 'cancel', onPress: () => setLast('two-cancel') },
            { text: 'OK', onPress: () => setLast('two-ok') },
          ])
        }
      >
        <Text style={styles.buttonText}>Two-button alert</Text>
      </PressableScale>

      <PressableScale
        testID="alert-three"
        style={styles.button}
        onPress={() =>
          Alert.alert('Three', 'Three button alert', [
            { text: 'Cancel', style: 'cancel', onPress: () => setLast('three-cancel') },
            { text: 'Save', onPress: () => setLast('three-save') },
            { text: 'Delete', style: 'destructive', onPress: () => setLast('three-delete') },
          ])
        }
      >
        <Text style={styles.buttonText}>Three-button alert</Text>
      </PressableScale>

      {last !== null && (
        <Text style={styles.last} testID="alert-last">
          Last: {last}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 24 },
  button: {
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  last: { marginTop: 16, color: '#34C759', fontSize: 18 },
});
