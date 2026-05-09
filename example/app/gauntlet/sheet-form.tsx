import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';

export default function SheetForm() {
  return (
    <View testID="form-sheet-content" style={styles.container}>
      <Text testID="form-sheet-title" style={styles.title}>
        formSheet
      </Text>
      <Text style={styles.body}>This screen presents as a formSheet on iOS.</Text>
      <TouchableOpacity
        testID="form-sheet-close-btn"
        onPress={() => router.back()}
        style={styles.btn}
      >
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
