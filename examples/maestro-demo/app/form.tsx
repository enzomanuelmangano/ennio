import { Stack } from 'expo-router';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's login form. Flows tap the "Login" button by index
// 1 (the screen title is the first "Login"), so the button text stays "Login".
export default function FormScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const onLogin = () => {
    if (email === 'correct@mobile.dev' && password === 'maestro') {
      setResult('Credentials are correct');
    } else {
      setResult('Invalid email or password');
    }
  };

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Login' }} />
      <View style={styles.content}>
        <TextInput
          style={styles.input}
          placeholder="Email"
          accessibilityLabel="Email"
          autoCapitalize="none"
          autoCorrect={false}
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          accessibilityLabel="Password"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
        />
        <Pressable
          style={styles.button}
          accessibilityLabel="Login"
          onPress={onLogin}
        >
          <Text style={styles.buttonText}>Login</Text>
        </Pressable>
        {result !== null && (
          <Text style={styles.result}>{result}</Text>
        )}
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
  result: { fontSize: 16, textAlign: 'center', marginTop: 8 },
});
