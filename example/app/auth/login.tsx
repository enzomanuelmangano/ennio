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

export default function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore(state => state.login);
  const isLoading = useAuthStore(state => state.isLoading);
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);

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
      router.replace('/');
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
      router.replace('/');
    } catch (error) {
      Alert.alert('Error', 'Demo login failed');
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Sign In',
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
          testID="login-screen"
        >
          {/* Hero */}
          <View style={styles.header}>
            <View
              style={[
                styles.logoCircle,
                { backgroundColor: c.systemBlue + '22' },
              ]}
            >
              <Text style={[styles.logoGlyph, { color: c.systemBlue }]}>
                ◔
              </Text>
            </View>
            <Text style={[styles.title, { color: c.label }]}>
              Welcome Back
            </Text>
            <Text style={[styles.subtitle, { color: c.secondaryLabel }]}>
              Sign in to continue shopping
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
                Email
              </Text>
              <TextInput
                style={[styles.fieldInput, { color: c.label }]}
                placeholder="your@email.com"
                placeholderTextColor={c.tertiaryLabel}
                value={email}
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
              <View style={styles.passwordWrap}>
                <TextInput
                  style={[styles.fieldInput, { color: c.label, flex: 1 }]}
                  placeholder="••••••••"
                  placeholderTextColor={c.tertiaryLabel}
                  value={password}
                  onChangeText={text => {
                    setPassword(text);
                    if (errors.password)
                      setErrors(prev => ({ ...prev, password: undefined }));
                  }}
                  secureTextEntry={!showPassword}
                  testID="password-input"
                />
                <PressableScale
                  style={styles.showPasswordBtn}
                  onPress={() => setShowPassword(!showPassword)}
                  testID="toggle-password"
                  hitSlop={8}
                >
                  <Text
                    style={[styles.showPasswordText, { color: c.systemBlue }]}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </Text>
                </PressableScale>
              </View>
            </View>
            {errors.password && (
              <Text
                style={[styles.errorText, { color: c.systemRed }]}
                testID="password-error"
              >
                {errors.password}
              </Text>
            )}
          </View>

          <PressableScale
            style={styles.forgotPassword}
            testID="forgot-password"
            hitSlop={8}
          >
            <Text style={[styles.forgotPasswordText, { color: c.systemBlue }]}>
              Forgot Password?
            </Text>
          </PressableScale>

          <PressableScale
            style={StyleSheet.flatten([
              styles.primaryButton,
              { backgroundColor: c.systemBlue },
              isLoading && { opacity: 0.6 },
            ])}
            onPress={handleLogin}
            enabled={!isLoading}
            testID="login-btn"
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>Sign In</Text>
            )}
          </PressableScale>

          <View style={styles.dividerRow}>
            <View
              style={[styles.dividerLine, { backgroundColor: c.separator }]}
            />
            <Text style={[styles.dividerText, { color: c.secondaryLabel }]}>
              or
            </Text>
            <View
              style={[styles.dividerLine, { backgroundColor: c.separator }]}
            />
          </View>

          <PressableScale
            style={StyleSheet.flatten([
              styles.secondaryButton,
              { backgroundColor: c.secondarySystemGroupedBackground },
            ])}
            onPress={handleDemoLogin}
            testID="demo-login-btn"
          >
            <Text style={[styles.secondaryButtonText, { color: c.label }]}>
              Continue with Demo Account
            </Text>
          </PressableScale>

          <View style={styles.socialButtons}>
            <PressableScale
              style={StyleSheet.flatten([
                styles.socialButton,
                { backgroundColor: c.label },
              ])}
              testID="apple-login"
            >
              <Text
                style={[
                  styles.socialText,
                  { color: c.systemBackground },
                ]}
              >
                 Apple
              </Text>
            </PressableScale>
            <PressableScale
              style={StyleSheet.flatten([
                styles.socialButton,
                {
                  backgroundColor: c.secondarySystemGroupedBackground,
                },
              ])}
              testID="google-login"
            >
              <Text style={[styles.socialText, { color: c.label }]}>
                G  Google
              </Text>
            </PressableScale>
          </View>

          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: c.secondaryLabel }]}>
              Don't have an account?{' '}
            </Text>
            <Link href="/auth/register" asChild>
              <PressableScale testID="go-to-register" hitSlop={6}>
                <Text style={[styles.signUpLink, { color: c.systemBlue }]}>
                  Sign Up
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
    marginBottom: 28,
    marginTop: 12,
  },
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  logoGlyph: {
    fontSize: 42,
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
    fontWeight: '400',
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
  passwordWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  showPasswordBtn: {
    paddingLeft: 10,
  },
  showPasswordText: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
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
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: 18,
    paddingVertical: 4,
  },
  forgotPasswordText: {
    fontSize: fontSize.subhead,
    fontWeight: '500',
  },
  primaryButton: {
    paddingVertical: 16,
    borderRadius: radius.button,
    alignItems: 'center',
    marginBottom: 18,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    marginHorizontal: 14,
    fontSize: fontSize.footnote,
    fontWeight: '500',
  },
  secondaryButton: {
    paddingVertical: 14,
    borderRadius: radius.button,
    alignItems: 'center',
    marginBottom: 12,
  },
  secondaryButtonText: {
    fontSize: fontSize.body,
    fontWeight: '500',
  },
  socialButtons: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  socialButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: radius.button,
  },
  socialText: {
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
  signUpLink: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
});
