// Touchable variants — every Pressable-like primitive RN exposes.
// One screen with N buttons; each increments its own counter so we
// can assert that the right one fired.

import { useState } from 'react';
import { View, Text, Pressable, TouchableOpacity, TouchableHighlight, StyleSheet } from 'react-native';
import { BaseButton } from 'react-native-gesture-handler';
import { PressableScale } from 'pressto';

export default function TouchablesScreen() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const inc = (k: string) => setCounts((c) => ({ ...c, [k]: (c[k] ?? 0) + 1 }));

  const Row = ({ name, render }: { name: string; render: () => React.ReactElement }) => (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{name}</Text>
      {render()}
      <Text style={styles.rowCount} testID={`count-${name}`}>
        {counts[name] ?? 0}
      </Text>
    </View>
  );

  return (
    <View style={styles.container} testID="touchables-screen">
      <Text style={styles.title}>Touchable variants</Text>

      <Row
        name="Pressable"
        render={() => (
          <Pressable testID="touch-pressable" style={styles.btn} onPress={() => inc('Pressable')}>
            <Text style={styles.btnText}>Tap</Text>
          </Pressable>
        )}
      />
      <Row
        name="TouchableOpacity"
        render={() => (
          <TouchableOpacity testID="touch-opacity" style={styles.btn} onPress={() => inc('TouchableOpacity')}>
            <Text style={styles.btnText}>Tap</Text>
          </TouchableOpacity>
        )}
      />
      <Row
        name="TouchableHighlight"
        render={() => (
          <TouchableHighlight testID="touch-highlight" style={styles.btn} onPress={() => inc('TouchableHighlight')}>
            <Text style={styles.btnText}>Tap</Text>
          </TouchableHighlight>
        )}
      />
      <Row
        name="BaseButton"
        render={() => (
          <BaseButton testID="touch-baseButton" style={styles.btn} onPress={() => inc('BaseButton')}>
            <Text style={styles.btnText}>Tap</Text>
          </BaseButton>
        )}
      />
      <Row
        name="PressableScale"
        render={() => (
          <PressableScale testID="touch-pressableScale" style={styles.btn} onPress={() => inc('PressableScale')}>
            <Text style={styles.btnText}>Tap</Text>
          </PressableScale>
        )}
      />
      <Row
        name="Blocked"
        render={() => (
          <View pointerEvents="none">
            <Pressable testID="touch-blocked" style={styles.btn} onPress={() => inc('Blocked')}>
              <Text style={styles.btnText}>Tap</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 12 },
  rowLabel: { width: 120, fontSize: 14 },
  btn: { backgroundColor: '#007AFF', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '600' },
  rowCount: { fontSize: 16, fontWeight: '700', minWidth: 30, textAlign: 'right' },
});
