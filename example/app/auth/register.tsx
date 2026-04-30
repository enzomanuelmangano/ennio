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

export default function RegisterScreen() {
  const router = useRouter();
  const register = useAuthStore(state => state.register);
  const isLoading = useAuthStore(state => state.isLoading);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<{
    name?: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
  }>({});
  const [acceptTerms, setAcceptTerms] = useState(false);

  const validate = () => {
    const newErrors: typeof errors = {};

    if (!name.trim()) {
      newErrors.name = 'Name is required';
    } else if (name.trim().length < 2) {
      newErrors.name = 'Name must be at least 2 characters';
    }

    if (!email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      newErrors.email = 'Invalid email format';
    }

    if (!password) {
      newErrors.password = 'Password is required';
    } else if (password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters';
    } else if (!/[A-Z]/.test(password)) {
      newErrors.password = 'Password must contain an uppercase letter';
    } else if (!/[0-9]/.test(password)) {
      newErrors.password = 'Password must contain a number';
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password';
    } else if (password !== confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleRegister = async () => {
    if (!validate()) {
      if (hapticEnabled) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      return;
    }

    if (!acceptTerms) {
      Alert.alert('Terms Required', 'Please accept the terms and conditions to continue.');
      return;
    }

    try {
      await register(name.trim(), email.toLowerCase().trim(), password);
      if (hapticEnabled) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      Alert.alert(
        'Welcome!',
        'Your account has been created successfully.',
        [{ text: 'Start Shopping', onPress: () => router.back() }]
      );
    } catch (error) {
      Alert.alert('Registration Failed', 'An error occurred. Please try again.');
    }
  };

  const getPasswordStrength = () => {
    if (!password) return null;
    let strength = 0;
    if (password.length >= 6) strength++;
    if (password.length >= 10) strength++;
    if (/[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password)) strength++;
    if (/[^A-Za-z0-9]/.test(password)) strength++;

    if (strength <= 2) return { label: 'Weak', color: '#FF3B30' };
    if (strength <= 3) return { label: 'Fair', color: '#FF9500' };
    if (strength <= 4) return { label: 'Good', color: '#34C759' };
    return { label: 'Strong', color: '#007AFF' };
  };

  const passwordStrength = getPasswordStrength();

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Create Account',
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
          testID="register-screen"
        >
          <View style={styles.header}>
            <Text style={styles.logo}>🎉</Text>
            <Text style={[styles.title, darkMode && styles.textLight]}>Join Tasto Shop</Text>
            <Text style={[styles.subtitle, darkMode && styles.subtitleDark]}>
              Create an account to start shopping
            </Text>
          </View>

          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={[styles.label, darkMode && styles.textLight]}>Full Name</Text>
              <TextInput
                style={[
                  styles.input,
                  darkMode && styles.inputDark,
                  errors.name && styles.inputError,
                ]}
                placeholder="John Doe"
                placeholderTextColor={darkMode ? '#666' : '#999'}
                value={name}
                onChangeText={text => {
                  setName(text);
                  if (errors.name) setErrors(prev => ({ ...prev, name: undefined }));
                }}
                autoCapitalize="words"
                testID="name-input"
              />
              {errors.name && (
                <Text style={styles.errorText} testID="name-error">{errors.name}</Text>
              )}
            </View>

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
              <TextInput
                style={[
                  styles.input,
                  darkMode && styles.inputDark,
                  errors.password && styles.inputError,
                ]}
                placeholder="Min. 6 characters"
                placeholderTextColor={darkMode ? '#666' : '#999'}
                value={password}
                onChangeText={text => {
                  setPassword(text);
                  if (errors.password) setErrors(prev => ({ ...prev, password: undefined }));
                }}
                secureTextEntry
                testID="password-input"
              />
              {passwordStrength && (
                <View style={styles.strengthContainer}>
                  <View style={styles.strengthBars}>
                    {[1, 2, 3, 4].map(i => (
                      <View
                        key={i}
                        style={[
                          styles.strengthBar,
                          {
                            backgroundColor:
                              i <= (passwordStrength.label === 'Weak' ? 1 :
                                   passwordStrength.label === 'Fair' ? 2 :
                                   passwordStrength.label === 'Good' ? 3 : 4)
                                ? passwordStrength.color
                                : '#e0e0e0',
                          },
                        ]}
                      />
                    ))}
                  </View>
                  <Text style={[styles.strengthLabel, { color: passwordStrength.color }]}>
                    {passwordStrength.label}
                  </Text>
                </View>
              )}
              {errors.password && (
                <Text style={styles.errorText} testID="password-error">{errors.password}</Text>
              )}
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, darkMode && styles.textLight]}>Confirm Password</Text>
              <TextInput
                style={[
                  styles.input,
                  darkMode && styles.inputDark,
                  errors.confirmPassword && styles.inputError,
                ]}
                placeholder="Re-enter your password"
                placeholderTextColor={darkMode ? '#666' : '#999'}
                value={confirmPassword}
                onChangeText={text => {
                  setConfirmPassword(text);
                  if (errors.confirmPassword) setErrors(prev => ({ ...prev, confirmPassword: undefined }));
                }}
                secureTextEntry
                testID="confirm-password-input"
              />
              {errors.confirmPassword && (
                <Text style={styles.errorText} testID="confirm-password-error">
                  {errors.confirmPassword}
                </Text>
              )}
            </View>

            <Pressable
              style={styles.termsContainer}
              onPress={() => setAcceptTerms(!acceptTerms)}
              testID="accept-terms"
            >
              <View style={[styles.checkbox, acceptTerms && styles.checkboxChecked]}>
                {acceptTerms && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={[styles.termsText, darkMode && styles.subtitleDark]}>
                I agree to the{' '}
                <Text style={styles.termsLink}>Terms of Service</Text>
                {' '}and{' '}
                <Text style={styles.termsLink}>Privacy Policy</Text>
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.registerButton,
                (!acceptTerms || isLoading) && styles.registerButtonDisabled,
              ]}
              onPress={handleRegister}
              disabled={!acceptTerms || isLoading}
              testID="register-btn"
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.registerButtonText}>Create Account</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.footer}>
            <Text style={[styles.footerText, darkMode && styles.subtitleDark]}>
              Already have an account?{' '}
            </Text>
            <Link href="/auth/login" asChild>
              <Pressable testID="go-to-login">
                <Text style={styles.signInLink}>Sign In</Text>
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
    marginBottom: 30,
    marginTop: 10,
  },
  logo: {
    fontSize: 50,
    marginBottom: 12,
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#666',
  },
  textLight: {
    color: '#fff',
  },
  subtitleDark: {
    color: '#aaa',
  },
  form: {
    marginBottom: 20,
  },
  inputGroup: {
    marginBottom: 18,
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
  errorText: {
    color: '#FF3B30',
    fontSize: 12,
    marginTop: 6,
  },
  strengthContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  strengthBars: {
    flexDirection: 'row',
    flex: 1,
    marginRight: 10,
  },
  strengthBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    marginRight: 4,
  },
  strengthLabel: {
    fontSize: 12,
    fontWeight: '600',
    width: 50,
  },
  termsContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 24,
    marginTop: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#ccc',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  checkmark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  termsText: {
    flex: 1,
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
  },
  termsLink: {
    color: '#007AFF',
    fontWeight: '500',
  },
  registerButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  registerButtonDisabled: {
    backgroundColor: '#99c9ff',
  },
  registerButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
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
  signInLink: {
    color: '#007AFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
