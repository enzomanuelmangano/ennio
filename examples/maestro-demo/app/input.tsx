import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const STORAGE_KEY = 'input_screen_text';

// Mirrors Maestro demo_app's input/keyboard screen. Text persists to
// AsyncStorage so a relaunch without clearState restores it; clearState empties.
export default function InputScreen() {
  const [text, setText] = useState('');

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (active && saved !== null) {
          setText(saved);
        }
      })
      .catch(() => {
        // Missing/unreadable key is fine: start with an empty field.
      });
    return () => {
      active = false;
    };
  }, []);

  const onSave = () => {
    void AsyncStorage.setItem(STORAGE_KEY, text);
  };

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Input & Navigation' }} />
      <View style={styles.content}>
        <TextInput
          testID="textInput"
          accessibilityLabel="textInput"
          style={styles.input}
          placeholder="Test Input Field"
          multiline
          value={text}
          onChangeText={setText}
        />
        <Pressable style={styles.button} accessibilityLabel="Save" onPress={onSave}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, gap: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#cccccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    minHeight: 96,
    textAlignVertical: 'top',
    borderCurve: 'continuous',
  },
  button: {
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
});
