import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Link, useRouter, Stack } from 'expo-router';
import { useAuthStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';

export default function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore(state => state.login);
  const isLoading = useAuthStore(state => state.isLoading);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [showPassword, setShowPassword] = useState(false);

  const validate = () => {
    const newErrors: typeof errors = {};

    if (!email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      newErrors.email = 'Invalid email format';
    }

    if (!password) {
      newErrors.password = 'Password is required';
    } else if (password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleLogin = async () => {
    if (!validate()) {
      if (hapticEnabled) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      return;
    }

    try {
      await login(email.toLowerCase().trim(), password);
      if (hapticEnabled) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
    } catch (error) {
      Alert.alert('Login Failed', 'Invalid email or password. Please try again.');
    }
  };

  const handleDemoLogin = async () => {
    setEmail('demo@example.com');
    setPassword('password123');
    try {
      await login('demo@example.com', 'password123');
      if (hapticEnabled) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
    } catch (error) {
      Alert.alert('Error', 'Demo login failed');
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Sign In',
          headerStyle: { backgroundColor: darkMode ? '#1a1a2e' : '#ffffff' },
          headerTintColor: darkMode ? '#ffffff' : '#000000',
        }}
      />
      <KeyboardAvoidingView
        style={[styles.container, darkMode && styles.containerDark]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          testID="login-screen"
        >
          <View style={styles.header}>
            <Text style={styles.logo}>🛍️</Text>
            <Text style={[styles.title, darkMode && styles.textLight]}>Welcome Back</Text>
            <Text style={[styles.subtitle, darkMode && styles.subtitleDark]}>
              Sign in to continue shopping
            </Text>
          </View>

          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={[styles.label, darkMode && styles.textLight]}>Email</Text>
              <TextInput
                style={[
                  styles.input,
                  darkMode && styles.inputDark,
                  errors.email && styles.inputError,
                ]}
                placeholder="your@email.com"
                placeholderTextColor={darkMode ? '#666' : '#999'}
                value={email}
                onChangeText={text => {
                  setEmail(text);
                  if (errors.email) setErrors(prev => ({ ...prev, email: undefined }));
                }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                testID="email-input"
              />
              {errors.email && (
                <Text style={styles.errorText} testID="email-error">{errors.email}</Text>
              )}
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, darkMode && styles.textLight]}>Password</Text>
              <View style={styles.passwordContainer}>
                <TextInput
                  style={[
                    styles.input,
                    styles.passwordInput,
                    darkMode && styles.inputDark,
                    errors.password && styles.inputError,
                  ]}
                  placeholder="••••••••"
                  placeholderTextColor={darkMode ? '#666' : '#999'}
                  value={password}
                  onChangeText={text => {
                    setPassword(text);
                    if (errors.password) setErrors(prev => ({ ...prev, password: undefined }));
                  }}
                  secureTextEntry={!showPassword}
                  testID="password-input"
                />
                <Pressable
                  style={styles.showPasswordBtn}
                  onPress={() => setShowPassword(!showPassword)}
                  testID="toggle-password"
                >
                  <Text style={styles.showPasswordText}>{showPassword ? '🙈' : '👁️'}</Text>
                </Pressable>
              </View>
              {errors.password && (
                <Text style={styles.errorText} testID="password-error">{errors.password}</Text>
              )}
            </View>

            <Pressable style={styles.forgotPassword} testID="forgot-password">
              <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
            </Pressable>

            <Pressable
              style={[styles.loginButton, isLoading && styles.loginButtonDisabled]}
              onPress={handleLogin}
              disabled={isLoading}
              testID="login-btn"
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.loginButtonText}>Sign In</Text>
              )}
            </Pressable>

            <View style={styles.divider}>
              <View style={[styles.dividerLine, darkMode && styles.dividerLineDark]} />
              <Text style={[styles.dividerText, darkMode && styles.subtitleDark]}>or</Text>
              <View style={[styles.dividerLine, darkMode && styles.dividerLineDark]} />
            </View>

            <Pressable
              style={[styles.demoButton, darkMode && styles.demoButtonDark]}
              onPress={handleDemoLogin}
              testID="demo-login-btn"
            >
              <Text style={[styles.demoButtonText, darkMode && styles.textLight]}>
                Continue with Demo Account
              </Text>
            </Pressable>

            <View style={styles.socialButtons}>
              <Pressable
                style={[styles.socialButton, darkMode && styles.socialButtonDark]}
                testID="google-login"
              >
                <Text style={styles.socialIcon}>🔵</Text>
                <Text style={[styles.socialText, darkMode && styles.textLight]}>Google</Text>
              </Pressable>
              <Pressable
                style={[styles.socialButton, darkMode && styles.socialButtonDark]}
                testID="apple-login"
              >
                <Text style={styles.socialIcon}>🍎</Text>
                <Text style={[styles.socialText, darkMode && styles.textLight]}>Apple</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.footer}>
            <Text style={[styles.footerText, darkMode && styles.subtitleDark]}>
              Don't have an account?{' '}
            </Text>
            <Link href="/auth/register" asChild>
              <Pressable testID="go-to-register">
                <Text style={styles.signUpLink}>Sign Up</Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  containerDark: {
    backgroundColor: '#16213e',
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
    marginTop: 20,
  },
  logo: {
    fontSize: 60,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
  textLight: {
    color: '#fff',
  },
  subtitleDark: {
    color: '#aaa',
  },
  form: {
    marginBottom: 30,
  },
  inputGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  inputDark: {
    backgroundColor: '#1a1a2e',
    borderColor: '#2a2a3e',
    color: '#fff',
  },
  inputError: {
    borderColor: '#FF3B30',
  },
  passwordContainer: {
    position: 'relative',
  },
  passwordInput: {
    paddingRight: 50,
  },
  showPasswordBtn: {
    position: 'absolute',
    right: 12,
    top: 12,
    padding: 4,
  },
  showPasswordText: {
    fontSize: 20,
  },
  errorText: {
    color: '#FF3B30',
    fontSize: 12,
    marginTop: 6,
  },
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: 24,
  },
  forgotPasswordText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '500',
  },
  loginButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  loginButtonDisabled: {
    backgroundColor: '#99c9ff',
  },
  loginButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e0e0e0',
  },
  dividerLineDark: {
    backgroundColor: '#2a2a3e',
  },
  dividerText: {
    marginHorizontal: 16,
    color: '#666',
    fontSize: 14,
  },
  demoButton: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    marginBottom: 16,
  },
  demoButtonDark: {
    backgroundColor: '#1a1a2e',
    borderColor: '#2a2a3e',
  },
  demoButtonText: {
    color: '#1a1a2e',
    fontSize: 15,
    fontWeight: '600',
  },
  socialButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  socialButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    marginHorizontal: 6,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  socialButtonDark: {
    backgroundColor: '#1a1a2e',
    borderColor: '#2a2a3e',
  },
  socialIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  socialText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 'auto',
    paddingBottom: 20,
  },
  footerText: {
    color: '#666',
    fontSize: 15,
  },
  signUpLink: {
    color: '#007AFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
