// Action sheet — each platform's system-rendered chooser. iOS uses
// ActionSheetIOS (out-of-process on iOS 18+, exercising Ennio's cross-process
// AX fallback). ActionSheetIOS is a no-op on Android, so there it falls back
// to Alert.alert — a native AlertDialog with the same options as real buttons.
// Both are system UI; the same flow ("Open", tap "Save") drives either.

import { useState } from 'react';
import { View, Text, ActionSheetIOS, Alert, Platform, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function ActionSheetScreen() {
  const [picked, setPicked] = useState<string | null>(null);
  const open = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Save', 'Delete'],
          cancelButtonIndex: 0,
          destructiveButtonIndex: 2,
          title: 'Choose action',
        },
        (idx) => {
          if (idx === 1) setPicked('Save');
          else if (idx === 2) setPicked('Delete');
          else setPicked('Cancel');
        },
      );
    } else {
      Alert.alert('Choose action', undefined, [
        { text: 'Cancel', style: 'cancel', onPress: () => setPicked('Cancel') },
        { text: 'Save', onPress: () => setPicked('Save') },
        { text: 'Delete', style: 'destructive', onPress: () => setPicked('Delete') },
      ]);
    }
  };

  return (
    <View style={styles.container} testID="action-sheet-screen">
      <Text style={styles.title}>Action sheet test</Text>
      <PressableScale testID="action-sheet-open" style={styles.button} onPress={open}>
        <Text style={styles.buttonText}>Open action sheet</Text>
      </PressableScale>
      {picked !== null && (
        <Text style={styles.picked} testID="action-sheet-picked">
          {picked}
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
    borderCurve: 'continuous',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  picked: { marginTop: 16, color: '#34C759', fontSize: 18 },
});
