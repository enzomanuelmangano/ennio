import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  ActivityIndicator,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { Link, useRouter, Stack } from 'expo-router';
import { useAuthStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, lineHeight, radius } from '../../src/theme';

export default function RegisterScreen() {
  const router = useRouter();
  const register = useAuthStore(state => state.register);
  const isLoading = useAuthStore(state => state.isLoading);
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);

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
      Alert.alert(
        'Terms Required',
        'Please accept the terms and conditions to continue.',
      );
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
        [{ text: 'Start Shopping', onPress: () => router.back() }],
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

    if (strength <= 2) return { label: 'Weak', color: c.systemRed, level: 1 };
    if (strength <= 3) return { label: 'Fair', color: c.systemOrange, level: 2 };
    if (strength <= 4) return { label: 'Good', color: c.systemGreen, level: 3 };
    return { label: 'Strong', color: c.systemBlue, level: 4 };
  };

  const passwordStrength = getPasswordStrength();

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Create Account',
          headerStyle: { backgroundColor: c.systemBackground },
          headerTintColor: c.label,
          headerLargeTitle: false,
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: c.systemGroupedBackground }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          testID="register-screen"
        >
          <View style={styles.header}>
            <View
              style={[
                styles.logoCircle,
                { backgroundColor: c.systemPurple + '22' },
              ]}
            >
              <Text style={[styles.logoGlyph, { color: c.systemPurple }]}>
                ✶
              </Text>
            </View>
            <Text style={[styles.title, { color: c.label }]}>
              Join Ennio Shop
            </Text>
            <Text style={[styles.subtitle, { color: c.secondaryLabel }]}>
              Create an account to start shopping
            </Text>
          </View>

          {/* Form card */}
          <View
            style={[
              styles.card,
              { backgroundColor: c.secondarySystemGroupedBackground },
            ]}
          >
            <View style={styles.fieldRow}>
              <Text style={[styles.fieldLabel, { color: c.secondaryLabel }]}>
                Name
              </Text>
              <TextInput
                style={[styles.fieldInput, { color: c.label }]}
                placeholder="John Doe"
                placeholderTextColor={c.tertiaryLabel}
                defaultValue={name}
                onChangeText={text => {
                  setName(text);
                  if (errors.name)
                    setErrors(prev => ({ ...prev, name: undefined }));
                }}
                autoCapitalize="words"
                testID="name-input"
              />
            </View>
            {errors.name && (
              <Text
                style={[styles.errorText, { color: c.systemRed }]}
                testID="name-error"
              >
                {errors.name}
              </Text>
            )}
            <View
              style={[styles.divider, { backgroundColor: c.separator }]}
            />
            <View style={styles.fieldRow}>
              <Text style={[styles.fieldLabel, { color: c.secondaryLabel }]}>
                Email
              </Text>
              <TextInput
                style={[styles.fieldInput, { color: c.label }]}
                placeholder="your@email.com"
                placeholderTextColor={c.tertiaryLabel}
                defaultValue={email}
                onChangeText={text => {
                  setEmail(text);
                  if (errors.email)
                    setErrors(prev => ({ ...prev, email: undefined }));
                }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                testID="email-input"
              />
            </View>
            {errors.email && (
              <Text
                style={[styles.errorText, { color: c.systemRed }]}
                testID="email-error"
              >
                {errors.email}
              </Text>
            )}
            <View
              style={[styles.divider, { backgroundColor: c.separator }]}
            />
            <View style={styles.fieldRow}>
              <Text style={[styles.fieldLabel, { color: c.secondaryLabel }]}>
                Password
              </Text>
              <TextInput
                style={[styles.fieldInput, { color: c.label }]}
                placeholder="Min. 6 characters"
                placeholderTextColor={c.tertiaryLabel}
                defaultValue={password}
                onChangeText={text => {
                  setPassword(text);
                  if (errors.password)
                    setErrors(prev => ({ ...prev, password: undefined }));
                }}
                secureTextEntry
                testID="password-input"
              />
            </View>
            {passwordStrength && (
              <View style={styles.strengthRow}>
                <View style={styles.strengthBars}>
                  {[1, 2, 3, 4].map(i => (
                    <View
                      key={i}
                      style={[
                        styles.strengthBar,
                        {
                          backgroundColor:
                            i <= passwordStrength.level
                              ? passwordStrength.color
                              : c.tertiarySystemFill,
                        },
                      ]}
                    />
                  ))}
                </View>
                <Text
                  style={[
                    styles.strengthLabel,
                    { color: passwordStrength.color },
                  ]}
                >
                  {passwordStrength.label}
                </Text>
              </View>
            )}
            {errors.password && (
              <Text
                style={[styles.errorText, { color: c.systemRed }]}
                testID="password-error"
              >
                {errors.password}
              </Text>
            )}
            <View
              style={[styles.divider, { backgroundColor: c.separator }]}
            />
            <View style={styles.fieldRow}>
              <Text style={[styles.fieldLabel, { color: c.secondaryLabel }]}>
                Confirm
              </Text>
              <TextInput
                style={[styles.fieldInput, { color: c.label }]}
                placeholder="Re-enter your password"
                placeholderTextColor={c.tertiaryLabel}
                defaultValue={confirmPassword}
                onChangeText={text => {
                  setConfirmPassword(text);
                  if (errors.confirmPassword)
                    setErrors(prev => ({
                      ...prev,
                      confirmPassword: undefined,
                    }));
                }}
                secureTextEntry
                testID="confirm-password-input"
              />
            </View>
            {errors.confirmPassword && (
              <Text
                style={[styles.errorText, { color: c.systemRed }]}
                testID="confirm-password-error"
              >
                {errors.confirmPassword}
              </Text>
            )}
          </View>

          <PressableScale
            style={styles.termsContainer}
            onPress={() => setAcceptTerms(!acceptTerms)}
            testID="accept-terms"
          >
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: acceptTerms ? c.systemBlue : c.opaqueSeparator,
                  backgroundColor: acceptTerms ? c.systemBlue : 'transparent',
                },
              ]}
            >
              {acceptTerms && <Text style={styles.checkmark}>✓</Text>}
            </View>
            <Text style={[styles.termsText, { color: c.secondaryLabel }]}>
              I agree to the{' '}
              <Text style={[styles.termsLink, { color: c.systemBlue }]}>
                Terms of Service
              </Text>
              {' '}and{' '}
              <Text style={[styles.termsLink, { color: c.systemBlue }]}>
                Privacy Policy
              </Text>
            </Text>
          </PressableScale>

          <PressableScale
            style={StyleSheet.flatten([
              styles.primaryButton,
              { backgroundColor: c.systemBlue },
              (!acceptTerms || isLoading) && { opacity: 0.4 },
            ])}
            onPress={handleRegister}
            enabled={acceptTerms && !isLoading}
            testID="register-btn"
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>Create Account</Text>
            )}
          </PressableScale>

          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: c.secondaryLabel }]}>
              Already have an account?{' '}
            </Text>
            <Link href="/auth/login" asChild>
              <PressableScale testID="go-to-login" hitSlop={6}>
                <Text style={[styles.signInLink, { color: c.systemBlue }]}>
                  Sign In
                </Text>
              </PressableScale>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    padding: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 22,
    marginTop: 8,
  },
  logoCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  logoGlyph: {
    fontSize: 38,
    fontWeight: '600',
  },
  title: {
    fontSize: fontSize.title1,
    lineHeight: lineHeight.title1,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: fontSize.subhead,
  },
  card: {
    borderRadius: radius.card,
    paddingVertical: 4,
    marginBottom: 14,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
  },
  fieldLabel: {
    fontSize: fontSize.body,
    width: 90,
    fontWeight: '500',
  },
  fieldInput: {
    flex: 1,
    fontSize: fontSize.body,
    paddingVertical: 6,
  },
  errorText: {
    fontSize: fontSize.caption1,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 14,
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    marginTop: -2,
  },
  strengthBars: {
    flexDirection: 'row',
    flex: 1,
    gap: 4,
    marginRight: 10,
  },
  strengthBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  strengthLabel: {
    fontSize: fontSize.caption1,
    fontWeight: '600',
    width: 50,
  },
  termsContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 22,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    marginTop: 2,
  },
  checkmark: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  termsText: {
    flex: 1,
    fontSize: fontSize.subhead,
    lineHeight: lineHeight.subhead,
  },
  termsLink: {
    fontWeight: '500',
  },
  primaryButton: {
    paddingVertical: 16,
    borderRadius: radius.button,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 'auto',
    paddingTop: 22,
    paddingBottom: 12,
  },
  footerText: {
    fontSize: fontSize.subhead,
  },
  signInLink: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
});
