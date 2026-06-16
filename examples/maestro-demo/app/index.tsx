import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Each entry mirrors a button on Maestro's demo_app home grid. The `label`
// is the exact text ennio/Maestro flows match with `tapOn`; `route` is the
// expo-router path. One screen per interaction archetype.
const SCREENS: { label: string; route: string }[] = [
  { label: 'Sensors', route: '/sensors' },
  { label: 'Location Test', route: '/location' },
  { label: 'Defects Test', route: '/defects' },
  { label: 'Nesting Test', route: '/nesting' },
  { label: 'Gesture Tester', route: '/gestures' },
  { label: 'Form Test', route: '/form' },
  { label: 'Input/Keyboard', route: '/input' },
  { label: 'issue 1677 repro', route: '/issue-1677' },
  { label: 'issue 1619 repro', route: '/issue-1619' },
  { label: 'Webview Test', route: '/webview' },
  { label: 'Webview Devtools Test', route: '/webview-devtools' },
  { label: 'Cropped Screenshot Test', route: '/cropped-screenshot' },
  { label: 'Notifications Permission', route: '/notifications' },
  { label: 'All Files Access', route: '/all-files' },
  { label: 'Connectivity Test', route: '/connectivity' },
  { label: 'Scrollable List', route: '/scrollable-list' },
  { label: 'Animation Test', route: '/animation' },
  { label: 'Orientation Test', route: '/orientation' },
  { label: 'Paging Test', route: '/paging' },
  { label: 'assertScreenshot Threshold', route: '/patient-care' },
];

export default function HomeScreen() {
  const router = useRouter();
  const [counter, setCounter] = useState(0);

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Maestro Demo' }} />
      <ScrollView contentContainerStyle={styles.content} testID="home-screen">
        <View style={styles.grid}>
          {SCREENS.map(({ label, route }) => (
            <Pressable
              key={route}
              testID={route}
              accessibilityLabel={label}
              style={styles.cell}
              onPress={() => router.push(route as never)}
            >
              <Text style={styles.cellText}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.counterRow}>
          <Text style={styles.counterLabel}>You have pushed the button this many times</Text>
          <Text testID="counterValue" style={styles.counterValue}>
            {counter}
          </Text>
        </View>
      </ScrollView>

      <Pressable
        testID="fabAddIcon"
        accessibilityLabel="Increment"
        style={styles.fab}
        onPress={() => setCounter((c) => c + 1)}
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 12, paddingBottom: 120 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: {
    width: '31%',
    minHeight: 64,
    backgroundColor: '#1565c0',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
    borderCurve: 'continuous',
  },
  cellText: { color: '#ffffff', fontSize: 12, textAlign: 'center' },
  counterRow: { marginTop: 24, alignItems: 'center' },
  counterLabel: { fontSize: 14, color: '#333', textAlign: 'center' },
  counterValue: { fontSize: 34, fontWeight: '300', marginTop: 8 },
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 36,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1565c0',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.3)',
  },
  fabText: { color: '#ffffff', fontSize: 28, lineHeight: 30 },
});
