import * as Network from 'expo-network';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's connectivity screen: polls network state once per
// second and shows a single "Online"/"Offline" label.
export default function ConnectivityScreen() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const state = await Network.getNetworkStateAsync();
        if (!cancelled) {
          setOnline(state.isConnected === true);
        }
      } catch {
        if (!cancelled) {
          setOnline(false);
        }
      }
    };

    void check();
    const interval = setInterval(() => {
      void check();
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Connectivity Test' }} />
      <View style={styles.content}>
        <Text
          style={styles.status}
          testID="connectivityStatus"
          accessibilityLabel="connectivityStatus"
        >
          {online ? 'Online' : 'Offline'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  status: { fontSize: 20, textAlign: 'center' },
});
