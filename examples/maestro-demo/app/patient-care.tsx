import { Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Mirrors Maestro demo_app's patient-care screenshot screen. Tapping
// "Toggle 10px" shifts the alert card down by exactly 10px, which is enough to
// break a screenshot-threshold assertion.
const BASE_TOP = 80;
const SHIFT = 10;

export default function PatientCareScreen() {
  const [shifted, setShifted] = useState(false);
  const cardTop = BASE_TOP + (shifted ? SHIFT : 0);

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ headerShown: false }} />

      <View
        testID="patientCareAlert"
        accessibilityLabel="patientCareAlert"
        style={[styles.card, { top: cardTop }]}
      >
        <Text style={styles.title}>Patient Care Made Mobile</Text>

        <View style={styles.row}>
          <Text style={styles.check}>✓</Text>
          <Text style={styles.rowText}>Keep your number private with a customizable caller ID</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.check}>✓</Text>
          <Text style={styles.rowText}>Secure Voice, Video &amp; Texting</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.check}>✓</Text>
          <Text style={styles.rowText}>Free &amp; HIPAA compliant</Text>
        </View>

        <View style={styles.dialerButton}>
          <Text style={styles.dialerButtonText}>Set up Dialer</Text>
        </View>
      </View>

      <Pressable
        testID="toggleShiftButton"
        accessibilityLabel="toggleShiftButton"
        style={styles.toggleButton}
        onPress={() => setShifted((s) => !s)}
      >
        <Text style={styles.toggleButtonText}>Toggle 10px</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#7F7F7F' },
  card: {
    position: 'absolute',
    left: 24,
    right: 24,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    gap: 12,
    borderCurve: 'continuous',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#000000' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  check: { fontSize: 16, color: '#1565c0', fontWeight: '700' },
  rowText: { flex: 1, fontSize: 15, color: '#333333' },
  dialerButton: {
    marginTop: 8,
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  dialerButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  toggleButton: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderCurve: 'continuous',
  },
  toggleButtonText: { color: '#000000', fontSize: 16, fontWeight: '600' },
});
