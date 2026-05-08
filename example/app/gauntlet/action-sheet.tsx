// Action sheet — ActionSheetIOS is system-rendered (out-of-process on
// iOS 18+). Tests Ennio's idb describe-OOP fallback for non-Fabric UI.

import { useState } from 'react';
import { View, Text, ActionSheetIOS, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function ActionSheetScreen() {
  const [picked, setPicked] = useState<string | null>(null);
  const open = () => {
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
  button: { backgroundColor: '#007AFF', padding: 14, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  picked: { marginTop: 16, color: '#34C759', fontSize: 18 },
});
