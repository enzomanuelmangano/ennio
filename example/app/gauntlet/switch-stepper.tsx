import { useState } from 'react';
import { View, Text, Switch, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function SwitchStepperScreen() {
  const [enabled, setEnabled] = useState(false);
  const [count, setCount] = useState(0);

  return (
    <View style={styles.container} testID="switch-stepper-screen">
      <Text style={styles.title}>Switch + Stepper test</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Notifications</Text>
        <Switch testID="switch-control" value={enabled} onValueChange={setEnabled} />
      </View>
      <Text testID="switch-state" style={styles.value}>
        {enabled ? 'on' : 'off'}
      </Text>

      <View style={[styles.row, { marginTop: 32 }]}>
        <Text style={styles.label}>Count</Text>
        <View style={styles.stepper}>
          <PressableScale
            testID="stepper-dec"
            style={styles.stepperBtn}
            onPress={() => setCount((c) => Math.max(0, c - 1))} hitSlop={2}
          >
            <Text style={styles.stepperBtnText}>−</Text>
          </PressableScale>
          <Text style={styles.stepperVal} testID="stepper-value">
            {count}
          </Text>
          <PressableScale
            testID="stepper-inc"
            style={styles.stepperBtn}
            onPress={() => setCount((c) => c + 1)} hitSlop={2}
          >
            <Text style={styles.stepperBtnText}>+</Text>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 24 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 16 },
  value: { fontSize: 14, color: '#666', marginTop: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepperBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperBtnText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  stepperVal: { fontSize: 20, fontWeight: '600', minWidth: 30, textAlign: 'center' },
});
