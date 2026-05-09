// Modal stacking — RN <Modal/> opened on top of an already-open modal.
// Validates Ennio reaches both presentation layers.

import { useState } from 'react';
import { View, Text, Modal, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

export default function ModalStackScreen() {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);

  return (
    <View style={styles.container} testID="modal-stack-screen">
      <Text style={styles.title}>Modal stacking</Text>
      <PressableScale
        testID="modal-open-first"
        style={styles.button}
        onPress={() => setFirst(true)}
      >
        <Text style={styles.buttonText}>Open modal 1</Text>
      </PressableScale>

      <Modal
        visible={first}
        transparent
        animationType="slide"
        onRequestClose={() => setFirst(false)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalCard} testID="modal-1-body">
            <Text style={styles.modalTitle}>Modal 1</Text>
            <PressableScale
              testID="modal-open-second"
              style={styles.button}
              onPress={() => setSecond(true)}
            >
              <Text style={styles.buttonText}>Open modal 2</Text>
            </PressableScale>
            <PressableScale
              testID="modal-close-first"
              style={styles.buttonAlt}
              onPress={() => setFirst(false)}
            >
              <Text style={styles.buttonText}>Close modal 1</Text>
            </PressableScale>
          </View>

          <Modal
            visible={second}
            transparent
            animationType="fade"
            onRequestClose={() => setSecond(false)}
          >
            <View style={styles.modalBg}>
              <View style={styles.modalCard} testID="modal-2-body">
                <Text style={styles.modalTitle}>Modal 2 (nested)</Text>
                <PressableScale
                  testID="modal-close-second"
                  style={styles.button}
                  onPress={() => setSecond(false)}
                >
                  <Text style={styles.buttonText}>Close modal 2</Text>
                </PressableScale>
              </View>
            </View>
          </Modal>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 24 },
  button: {
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonAlt: { backgroundColor: '#FF3B30', padding: 14, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 12, padding: 20 },
  modalTitle: { fontSize: 20, fontWeight: '700', marginBottom: 16 },
});
