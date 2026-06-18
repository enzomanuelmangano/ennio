// Modal stacking — RN <Modal/> opened on top of an already-open modal.
// Validates Ennio reaches both presentation layers.

import { useState } from 'react';
import { View, Text, Modal, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
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
        {/* RNGH gestures (pressto buttons) inside a RN Modal need their own
            GestureHandlerRootView on Android — the Modal is a separate window
            with no orchestrator otherwise, so taps never recognize (iOS
            attaches recognizers per-window automatically). */}
        <GestureHandlerRootView style={styles.flex}>
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
              <GestureHandlerRootView style={styles.flex}>
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
              </GestureHandlerRootView>
            </Modal>
          </View>
        </GestureHandlerRootView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 24 },
  button: {
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
    borderCurve: 'continuous',
  },
  buttonAlt: {
    backgroundColor: '#FF3B30',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 12, padding: 20, borderCurve: 'continuous' },
  modalTitle: { fontSize: 20, fontWeight: '700', marginBottom: 16 },
});
