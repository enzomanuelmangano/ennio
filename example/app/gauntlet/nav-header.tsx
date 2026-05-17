// Native navigation header buttons (RNScreens) — exercises
// headerRight / headerLeft / back. Validates Ennio can tap items
// rendered into UINavigationBar's bar button slots.

import { useState } from 'react';
import { router, Stack } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function NavHeaderScreen() {
  const [last, setLast] = useState<string | null>(null);

  return (
    <View style={styles.container} testID="nav-header-screen">
      <Stack.Screen
        options={{
          title: 'Header',
          headerLeft: () => (
            <PressableScale
              testID="header-cancel-btn"
              style={styles.headerBtn}
              onPress={() => setLast('cancel')}
            >
              <Text style={styles.headerLeftText}>Cancel</Text>
            </PressableScale>
          ),
          headerRight: () => (
            <View style={styles.headerRightGroup}>
              <PressableScale
                testID="header-edit-btn"
                style={styles.headerBtn}
                onPress={() => setLast('edit')}
              >
                <Text style={styles.headerRightText}>Edit</Text>
              </PressableScale>
              <PressableScale
                testID="header-save-btn"
                style={styles.headerBtn}
                onPress={() => setLast('save')}
              >
                <Text style={styles.headerRightText}>Save</Text>
              </PressableScale>
            </View>
          ),
        }}
      />
      <Text style={styles.title}>Header items</Text>
      <Text style={styles.body}>
        Tap headerLeft (Cancel), headerRight (Edit / Save), or the iOS back chevron.
      </Text>
      {last !== null && (
        <Text style={styles.last} testID="header-last">
          Last: {last}
        </Text>
      )}
      <PressableScale
        testID="header-go-back-btn"
        style={styles.bodyBtn}
        onPress={() => router.back()}
      >
        <Text style={styles.bodyBtnText}>Go back (programmatic)</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 12 },
  body: { fontSize: 14, color: '#666', marginBottom: 24 },
  last: { color: '#34C759', fontSize: 18, marginBottom: 24 },
  headerBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  headerRightGroup: { flexDirection: 'row', gap: 4 },
  headerLeftText: { color: '#FF3B30', fontSize: 16 },
  headerRightText: { color: '#007AFF', fontSize: 16, fontWeight: '600' },
  bodyBtn: {
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
    borderCurve: 'continuous',
  },
  bodyBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
