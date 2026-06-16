import * as Notifications from 'expo-notifications';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's notification permission screen: shows the current
// permission status and a button to request it.
export default function NotificationsScreen() {
  const [status, setStatus] = useState('Not requested');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await Notifications.getPermissionsAsync();
      if (!cancelled) {
        setStatus(result.status);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const onRequest = async () => {
    const result = await Notifications.requestPermissionsAsync();
    setStatus(result.status);
  };

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Notifications Permission' }} />
      <View style={styles.content}>
        <Text
          style={styles.status}
          testID="permissionStatus"
          accessibilityLabel="permissionStatus"
        >
          {`Status: ${status}`}
        </Text>
        <Pressable
          style={styles.button}
          testID="requestPermissionButton"
          accessibilityLabel="requestPermissionButton"
          onPress={onRequest}
        >
          <Text style={styles.buttonText}>Request Notification Permission</Text>
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
