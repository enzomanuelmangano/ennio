import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TouchableHighlight,
  TouchableWithoutFeedback,
  Pressable,
  Switch,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { PressableScale, PressableOpacity } from 'pressto';

/**
 * Every common RN pressable variant in one screen. Each variant fires
 * `recordHit(name)` so the yaml flow can verify Ennio actually drove a
 * tap by checking the on-screen "Last hit" badge + "Total hits" counter.
 *
 * Variants covered:
 *   - core: Pressable, TouchableOpacity, TouchableHighlight,
 *           TouchableWithoutFeedback, Button, Switch
 *   - third-party: PressableScale + TouchableScale (pressto)
 *   - gesture-handler: GestureDetector with Tap()
 */
export default function Pressables() {
  const [last, setLast] = useState<string>('—');
  const [count, setCount] = useState(0);
  const [switchOn, setSwitchOn] = useState(false);

  const hit = (name: string) => {
    setLast(name);
    setCount((c) => c + 1);
  };

  const tap = Gesture.Tap().onEnd(() => {
    'worklet';
    runOnJS(hit)('GestureDetector');
  });

  return (
    <ScrollView contentContainerStyle={styles.content} testID="pressables-scroll">
      <Text style={styles.h1}>Pressables</Text>

      <View testID="hit-badge" style={styles.badge}>
        <Text style={styles.badgeLabel}>Last hit</Text>
        <Text testID="hit-last" style={styles.badgeValue}>
          {last}
        </Text>
        <Text testID="hit-count" style={styles.badgeCount}>
          Total: {count}
        </Text>
      </View>

      <Row label="Pressable">
        <Pressable
          testID="press-pressable"
          onPress={() => hit('Pressable')}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        >
          <Text style={styles.btnText}>Tap me</Text>
        </Pressable>
      </Row>

      <Row label="TouchableOpacity">
        <TouchableOpacity
          testID="press-touchable-opacity"
          onPress={() => hit('TouchableOpacity')}
          style={styles.btn}
        >
          <Text style={styles.btnText}>Tap me</Text>
        </TouchableOpacity>
      </Row>

      <Row label="TouchableHighlight">
        <TouchableHighlight
          testID="press-touchable-highlight"
          onPress={() => hit('TouchableHighlight')}
          underlayColor="#0a5cd1"
          style={styles.btn}
        >
          <Text style={styles.btnText}>Tap me</Text>
        </TouchableHighlight>
      </Row>

      <Row label="TouchableWithoutFeedback">
        <TouchableWithoutFeedback
          testID="press-touchable-without-feedback"
          onPress={() => hit('TouchableWithoutFeedback')}
        >
          <View style={styles.btn}>
            <Text style={styles.btnText}>Tap me</Text>
          </View>
        </TouchableWithoutFeedback>
      </Row>

      <Row label="PressableScale (pressto)">
        <PressableScale
          testID="press-pressable-scale"
          onPress={() => hit('PressableScale')}
          style={styles.btn}
        >
          <Text style={styles.btnText}>Tap me</Text>
        </PressableScale>
      </Row>

      <Row label="PressableOpacity (pressto)">
        <PressableOpacity
          testID="press-pressable-opacity-pressto"
          onPress={() => hit('PressableOpacity')}
          style={styles.btn}
        >
          <Text style={styles.btnText}>Tap me</Text>
        </PressableOpacity>
      </Row>

      <Row label="GestureDetector (RNGH Tap)">
        <GestureDetector gesture={tap}>
          <View testID="press-gesture-detector" style={styles.btn}>
            <Text style={styles.btnText}>Tap me</Text>
          </View>
        </GestureDetector>
      </Row>

      <Row label="Switch (toggle)">
        <Switch
          testID="press-switch"
          value={switchOn}
          onValueChange={(v) => {
            setSwitchOn(v);
            hit('Switch');
          }}
        />
      </Row>

      {/* Long-press only target */}
      <Row label="Pressable (longPress only)">
        <Pressable
          testID="press-long"
          onLongPress={() => hit('LongPress')}
          delayLongPress={400}
          style={styles.btn}
        >
          <Text style={styles.btnText}>Long-press me</Text>
        </Pressable>
      </Row>

      {/* Double-tap target */}
      <Row label="Pressable (double-tap)">
        <DoubleTapBox onDoubleTap={() => hit('DoubleTap')} />
      </Row>
    </ScrollView>
  );
}

function DoubleTapBox({ onDoubleTap }: { onDoubleTap: () => void }) {
  const [last, setLast] = useState(0);
  return (
    <Pressable
      testID="press-double"
      onPress={() => {
        const now = Date.now();
        if (now - last < 350) onDoubleTap();
        setLast(now);
      }}
      style={styles.btn}
    >
      <Text style={styles.btnText}>Double-tap me</Text>
    </Pressable>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowControl}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 8, paddingBottom: 64, backgroundColor: '#fff' },
  h1: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  badge: {
    backgroundColor: '#f0f4ff',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    gap: 4,
  },
  badgeLabel: { fontSize: 12, color: '#666' },
  badgeValue: { fontSize: 18, fontWeight: '700', color: '#000' },
  badgeCount: { fontSize: 13, color: '#666' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  rowLabel: { fontSize: 14, fontWeight: '500', flex: 1, marginRight: 12 },
  rowControl: { minWidth: 140, alignItems: 'flex-end' },
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    alignItems: 'center',
    minWidth: 140,
  },
  btnPressed: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '600' },
});
