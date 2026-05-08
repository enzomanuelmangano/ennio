import { FlashList } from '@shopify/flash-list';
import { Text, View, StyleSheet } from 'react-native';

const ITEMS = Array.from({ length: 200 }, (_, i) => ({ id: `flash-${i}`, label: `Item #${i + 1}` }));

export default function FlashListScreen() {
  return (
    <View style={{ flex: 1 }} testID="flashlist-screen">
      <FlashList
        testID="flashlist-list"
        data={ITEMS}
        renderItem={({ item }) => (
          <View style={styles.row} testID={item.id}>
            <Text style={styles.label}>{item.label}</Text>
          </View>
        )}
        keyExtractor={(item) => item.id}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderColor: '#eee' },
  label: { fontSize: 16 },
});
