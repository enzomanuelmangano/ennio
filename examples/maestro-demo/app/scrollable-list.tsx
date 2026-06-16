import { Stack } from 'expo-router';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's scrollable list: 20 tall rows so the list must
// scroll on a phone. Rows read "Item 1" … "Item 20" (1-indexed).
const DATA: number[] = Array.from({ length: 20 }, (_, i) => i + 1);

export default function ScrollableListScreen() {
  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Scrollable List' }} />
      <FlatList
        data={DATA}
        keyExtractor={(n) => String(n)}
        renderItem={({ item: n }) => (
          <View testID={`item-${n}`} style={styles.row}>
            <Text style={styles.rowText}>{`Item ${n}`}</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  row: {
    height: 88,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dddddd',
  },
  rowText: { fontSize: 18 },
});
