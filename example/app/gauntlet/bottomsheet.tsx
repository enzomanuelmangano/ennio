import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function BottomSheetScreen() {
  const sheet = useRef<BottomSheet>(null);
  const [opened, setOpened] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);

  return (
    <View style={styles.container} testID="bottomsheet-screen">
      <Text style={styles.title}>Bottom sheet test</Text>
      <PressableScale
        testID="bottomsheet-open"
        style={styles.button}
        onPress={() => {
          // Mount the sheet on demand (gorhom's `<BottomSheet>` snaps
          // to its first snap point when first rendered, which is more
          // reliable than `ref.expand()` — the latter requires an
          // already-mounted Reanimated worklet that's flaky on first
          // open under iOS 26 sim).
          setSheetMounted(true);
          setOpened(true);
        }}
      >
        <Text style={styles.buttonText}>Open sheet</Text>
      </PressableScale>
      {opened && (
        <Text style={styles.opened} testID="bottomsheet-opened-marker">
          Sheet opened at least once
        </Text>
      )}
      {sheetMounted && (
        <BottomSheet
          ref={sheet}
          index={0}
          snapPoints={['40%', '80%']}
          enablePanDownToClose
          onClose={() => setSheetMounted(false)}
        >
          <BottomSheetView style={styles.sheetBody} testID="bottomsheet-body">
            <Text style={styles.sheetTitle}>Hello from sheet</Text>
            <PressableScale
              testID="bottomsheet-close"
              style={styles.button}
              onPress={() => sheet.current?.close()}
            >
              <Text style={styles.buttonText}>Close</Text>
            </PressableScale>
          </BottomSheetView>
        </BottomSheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  button: { backgroundColor: '#007AFF', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 12 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  opened: { marginTop: 12, color: '#34C759' },
  sheetBody: { flex: 1, padding: 20 },
  sheetTitle: { fontSize: 20, fontWeight: '600', marginBottom: 16 },
});
