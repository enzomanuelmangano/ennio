import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';

export default function SheetPage() {
  return (
    <View testID="page-sheet-content" style={styles.container}>
      <Text testID="page-sheet-title" style={styles.title}>
        pageSheet
      </Text>
      <Text style={styles.body}>
        This screen presents as a pageSheet on iOS (full-height card).
      </Text>
      <TouchableOpacity
        testID="page-sheet-close-btn"
        onPress={() => router.back()}
        style={styles.btn}>
        <Text style={styles.btnText}>Close</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 16, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700' },
  body: { fontSize: 15 },
  btn: {
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { color: '#fff', fontWeight: '600' },
});
