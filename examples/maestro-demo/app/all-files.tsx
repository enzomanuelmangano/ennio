import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's "all files access" screen. This is an Android
// MANAGE_EXTERNAL_STORAGE concept with no real native module available here, so
// the check is stubbed and always resolves to "Not allowed".
const checkAllFilesAccess = (): Promise<boolean> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(false), 300);
  });

export default function AllFilesScreen() {
  const [status, setStatus] = useState('Checking...');

  const runCheck = useCallback(() => {
    let cancelled = false;
    setStatus('Checking...');
    void checkAllFilesAccess().then((allowed) => {
      if (!cancelled) {
        setStatus(allowed ? 'Allowed' : 'Not allowed');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = runCheck();
    return cleanup;
  }, [runCheck]);

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'All Files Access' }} />
      <View style={styles.content}>
        <Text
          style={styles.status}
          testID="allFilesAccessStatus"
          accessibilityLabel="allFilesAccessStatus"
        >
          {status}
        </Text>
        <Pressable
          style={styles.button}
          testID="refreshAllFilesAccessButton"
          accessibilityLabel="refreshAllFilesAccessButton"
          onPress={runCheck}
        >
          <Text style={styles.buttonText}>Refresh</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, gap: 16 },
  status: { fontSize: 16 },
  button: {
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
});
