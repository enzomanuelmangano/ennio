import {
  Accelerometer,
  AccelerometerMeasurement,
  Barometer,
  Gyroscope,
  GyroscopeMeasurement,
  LightSensor,
  Magnetometer,
} from 'expo-sensors';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's sensors screen: a scrollable list of sensor cards
// grouped by section. Each card reports the sensor's availability and, for the
// motion sensors, streams live X/Y/Z values. Availability checks and live
// subscriptions are wrapped in try/catch so the screen degrades gracefully on a
// simulator where most sensors are unavailable.

type Availability = 'unknown' | 'available' | 'unavailable';

function AvailabilityBadge({ status }: { status: Availability }) {
  if (status === 'available') {
    return (
      <Text
        testID="badge-available"
        accessibilityLabel="Available"
        style={[styles.badge, styles.badgeAvailable]}
      >
        Available
      </Text>
    );
  }
  return (
    <Text
      testID="badge-not-available"
      accessibilityLabel="Not Available"
      style={[styles.badge, styles.badgeUnavailable]}
    >
      Not Available
    </Text>
  );
}

function formatXYZ(value: { x: number; y: number; z: number }): string {
  return `X: ${value.x.toFixed(2)}  Y: ${value.y.toFixed(2)}  Z: ${value.z.toFixed(2)}`;
}

export default function SensorsScreen() {
  const [accelAvailable, setAccelAvailable] = useState<Availability>('unknown');
  const [gyroAvailable, setGyroAvailable] = useState<Availability>('unknown');
  const [magAvailable, setMagAvailable] = useState<Availability>('unknown');
  const [baroAvailable, setBaroAvailable] = useState<Availability>('unknown');
  const [lightAvailable, setLightAvailable] = useState<Availability>('unknown');

  const [accel, setAccel] = useState<AccelerometerMeasurement>({
    x: 0,
    y: 0,
    z: 0,
    timestamp: 0,
  });
  const [gyro, setGyro] = useState<GyroscopeMeasurement>({
    x: 0,
    y: 0,
    z: 0,
    timestamp: 0,
  });

  // Check availability of every sensor once on mount.
  useEffect(() => {
    let cancelled = false;

    const check = async (
      sensor: { isAvailableAsync: () => Promise<boolean> },
      set: (status: Availability) => void
    ) => {
      try {
        const ok = await sensor.isAvailableAsync();
        if (!cancelled) {
          set(ok ? 'available' : 'unavailable');
        }
      } catch {
        if (!cancelled) {
          set('unavailable');
        }
      }
    };

    void check(Accelerometer, setAccelAvailable);
    void check(Gyroscope, setGyroAvailable);
    void check(Magnetometer, setMagAvailable);
    void check(Barometer, setBaroAvailable);
    void check(LightSensor, setLightAvailable);

    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to live Accelerometer values.
  useEffect(() => {
    try {
      Accelerometer.setUpdateInterval(200);
      const subscription = Accelerometer.addListener(setAccel);
      return () => {
        subscription.remove();
      };
    } catch {
      return undefined;
    }
  }, []);

  // Subscribe to live Gyroscope values.
  useEffect(() => {
    try {
      Gyroscope.setUpdateInterval(200);
      const subscription = Gyroscope.addListener(setGyro);
      return () => {
        subscription.remove();
      };
    } catch {
      return undefined;
    }
  }, []);

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Sensors' }} />
      <ScrollView
        testID="sensors-scroll"
        contentContainerStyle={styles.content}
      >
        <Text style={styles.sectionHeader}>Motion Sensors</Text>

        <View testID="card-accelerometer" style={styles.card}>
          <View style={styles.cardRow}>
            <Text style={styles.sensorName}>Accelerometer</Text>
            <AvailabilityBadge status={accelAvailable} />
          </View>
          <Text testID="accelerometer-values" style={styles.values}>
            {formatXYZ(accel)}
          </Text>
        </View>

        <View testID="card-gyroscope" style={styles.card}>
          <View style={styles.cardRow}>
            <Text style={styles.sensorName}>Gyroscope</Text>
            <AvailabilityBadge status={gyroAvailable} />
          </View>
          <Text testID="gyroscope-values" style={styles.values}>
            {formatXYZ(gyro)}
          </Text>
        </View>

        <Text style={styles.sectionHeader}>Orientation Sensors</Text>

        <View testID="card-magnetometer" style={styles.card}>
          <View style={styles.cardRow}>
            <Text style={styles.sensorName}>Magnetometer</Text>
            <AvailabilityBadge status={magAvailable} />
          </View>
        </View>

        <Text style={styles.sectionHeader}>Environmental Sensors</Text>

        <View testID="card-barometer" style={styles.card}>
          <View style={styles.cardRow}>
            <Text style={styles.sensorName}>Barometer</Text>
            <AvailabilityBadge status={baroAvailable} />
          </View>
        </View>

        <View testID="card-light-sensor" style={styles.card}>
          <View style={styles.cardRow}>
            <Text style={styles.sensorName}>Light Sensor</Text>
            <AvailabilityBadge status={lightAvailable} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, paddingBottom: 32 },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '700',
    color: '#616161',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    borderCurve: 'continuous',
    padding: 16,
    marginBottom: 12,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sensorName: { fontSize: 16, fontWeight: '600', color: '#212121' },
  badge: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  badgeAvailable: { color: '#1b5e20', backgroundColor: '#c8e6c9' },
  badgeUnavailable: { color: '#b71c1c', backgroundColor: '#ffcdd2' },
  values: {
    marginTop: 10,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    color: '#424242',
  },
});
