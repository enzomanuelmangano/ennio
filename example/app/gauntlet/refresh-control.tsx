// RefreshControl pull-to-refresh — exercises the iOS-native
// UIRefreshControl rendered by RN's ScrollView refreshControl prop.
// Validates Ennio can trigger pull-to-refresh via a top-anchored
// swipe-down gesture.

import { useCallback, useState } from 'react';
import { ScrollView, RefreshControl, View, Text, StyleSheet } from 'react-native';

export default function RefreshControlScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [count, setCount] = useState(0);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => {
      setCount((c) => c + 1);
      setRefreshing(false);
    }, 600);
  }, []);

  return (
    <ScrollView
      testID="refresh-control-screen"
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          testID="refresh-control"
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      }
    >
      <Text style={styles.title}>Pull-to-refresh</Text>
      <Text style={styles.body}>
        Pull down from the top of this list to trigger the refresh spinner.
      </Text>
      <Text style={styles.count} testID="refresh-count">
        Refreshed: {count}
      </Text>
      {Array.from({ length: 20 }).map((_, i) => (
        <View key={i} style={styles.row} testID={`row-${i}`}>
          <Text style={styles.rowText}>Item #{i}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 120 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 8 },
  body: { fontSize: 14, color: '#666', marginBottom: 16 },
  count: { fontSize: 18, color: '#34C759', marginBottom: 24 },
  row: {
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
    borderCurve: 'continuous',
  },
  rowText: { fontSize: 16 },
});
