import { Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { router } from 'expo-router';

export default function SheetTransparent() {
  return (
    <Pressable
      testID="transparent-modal-backdrop"
      style={styles.backdrop}
      onPress={() => router.back()}
    >
      <Pressable testID="transparent-modal-card" onPress={() => {}} style={styles.card}>
        <Text testID="transparent-modal-title" style={styles.title}>
          transparentModal
        </Text>
        <Text style={styles.body}>Tap outside to dismiss, or use the close button.</Text>
        <TouchableOpacity
          testID="transparent-modal-close-btn"
          onPress={() => router.back()}
          style={styles.btn}
        >
          <Text style={styles.btnText}>Close</Text>
        </TouchableOpacity>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    padding: 24,
    borderRadius: 12,
    gap: 12,
    width: '100%',
    maxWidth: 360,
  },
  title: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 14, color: '#666' },
  btn: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    marginTop: 4,
  },
  btnText: { color: '#fff', fontWeight: '600' },
});
