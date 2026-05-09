import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { useState } from 'react';
import { router } from 'expo-router';

export default function SheetStacked() {
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <View testID="stacked-modal-content" style={styles.container}>
      <Text testID="stacked-modal-title" style={styles.title}>
        Stacked modal
      </Text>
      <Text style={styles.body}>
        First-level modal. Open another modal on top to test stacking.
      </Text>
      <TouchableOpacity
        testID="stacked-open-inner-btn"
        onPress={() => setInnerOpen(true)}
        style={styles.btn}
      >
        <Text style={styles.btnText}>Open inner modal</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="stacked-close-outer-btn"
        onPress={() => router.back()}
        style={styles.btnSecondary}
      >
        <Text style={styles.btnText}>Close outer</Text>
      </TouchableOpacity>

      <Modal
        visible={innerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setInnerOpen(false)}
      >
        <View testID="inner-modal-backdrop" style={styles.innerBackdrop}>
          <View testID="inner-modal-card" style={styles.innerCard}>
            <Text testID="inner-modal-title" style={styles.innerTitle}>
              Inner modal
            </Text>
            <Text testID="inner-modal-body" style={styles.body}>
              Stacked above outer modal.
            </Text>
            <TouchableOpacity
              testID="inner-modal-close-btn"
              onPress={() => setInnerOpen(false)}
              style={styles.btn}
            >
              <Text style={styles.btnText}>Close inner</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 26, fontWeight: '700' },
  body: { fontSize: 15, color: '#444' },
  btn: {
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#007AFF',
    alignItems: 'center',
  },
  btnSecondary: {
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#666',
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '600' },
  innerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  innerCard: {
    backgroundColor: '#fff',
    padding: 24,
    borderRadius: 12,
    gap: 12,
    width: '100%',
    maxWidth: 320,
  },
  innerTitle: { fontSize: 20, fontWeight: '700' },
});
