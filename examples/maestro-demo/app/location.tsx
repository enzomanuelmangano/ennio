import * as Location from 'expo-location';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's location screen: requests foreground permission,
// then streams positions and renders lat/lon/accuracy with fixed precision.
export default function LocationScreen() {
  const [coords, setCoords] = useState<Location.LocationObjectCoords | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    const start = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (!cancelled) {
            setError('Location permission denied');
          }
          return;
        }
        subscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High },
          (position) => {
            if (!cancelled) {
              setCoords(position.coords);
            }
          },
        );
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Location Test' }} />
      <View style={styles.content}>
        {error !== null ? (
          <Text style={styles.text}>{`Error: ${error}`}</Text>
        ) : coords === null ? (
          <Text style={styles.text}>Waiting for location...</Text>
        ) : (
          <>
            <Text style={styles.text}>{`Latitude: ${coords.latitude.toFixed(6)}`}</Text>
            <Text style={styles.text}>{`Longitude: ${coords.longitude.toFixed(6)}`}</Text>
            <Text style={styles.text}>{`Accuracy: ${(coords.accuracy ?? 0).toFixed(1)} m`}</Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, gap: 8 },
  text: { fontSize: 16 },
});
