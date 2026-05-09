import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, Alert } from 'react-native';
import { PressableScale } from 'pressto';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore, useCartStore, useSettingsStore } from '../../../store';
import { useTheme, type Theme } from '../../../theme';
import * as Haptics from 'expo-haptics';

function MenuItem({
  icon,
  label,
  value,
  onPress,
  testID,
  danger = false,
  styles,
  theme,
  isLast = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  onPress: () => void;
  testID: string;
  danger?: boolean;
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
  isLast?: boolean;
}) {
  return (
    <PressableScale
      style={[styles.menuItem, isLast && styles.menuItemLast]}
      onPress={onPress}
      testID={testID}
    >
      <View style={styles.menuItemLeft}>
        <View style={[styles.menuIconWrap, danger && styles.menuIconWrapDanger]}>
          <Ionicons
            name={icon}
            size={18}
            color={danger ? theme.colors.danger : theme.colors.text.primary}
          />
        </View>
        <Text style={[styles.menuLabel, danger && styles.dangerText]}>{label}</Text>
      </View>
      <View style={styles.menuItemRight}>
        {value ? <Text style={styles.menuValue}>{value}</Text> : null}
        <Ionicons name="chevron-forward" size={16} color={theme.colors.text.muted} />
      </View>
    </PressableScale>
  );
}

function ProfileHeader({
  styles,
  theme,
}: {
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
}) {
  const user = useAuthStore((state) => state.user);

  return (
    <View style={styles.profileHeader} testID="profile-header">
      <Image source={{ uri: user?.avatar || 'https://i.pravatar.cc/150' }} style={styles.avatar} />
      <View style={styles.profileInfo}>
        <Text style={styles.profileName}>{user?.name}</Text>
        <Text style={styles.profileEmail}>{user?.email}</Text>
      </View>
      <Link href="/settings" asChild>
        <PressableScale style={styles.editButton} testID="edit-profile-btn">
          <Ionicons name="pencil" size={15} color={theme.colors.text.primary} />
        </PressableScale>
      </Link>
    </View>
  );
}

function StatsCard({ styles, theme }: { styles: ReturnType<typeof createStyles>; theme: Theme }) {
  const orders = useCartStore((state) => state.orders);
  const items = useCartStore((state) => state.items);

  const totalSpent = orders.reduce((sum, order) => sum + order.total, 0);

  return (
    <View style={styles.statsCard} testID="stats-card">
      <View style={styles.statItem}>
        <Text style={styles.statValue}>{orders.length}</Text>
        <Text style={styles.statLabel}>Orders</Text>
      </View>
      <View style={styles.statDivider} />
      <View style={styles.statItem}>
        <Text style={styles.statValue}>{items.length}</Text>
        <Text style={styles.statLabel}>In Cart</Text>
      </View>
      <View style={styles.statDivider} />
      <View style={styles.statItem}>
        <Text style={[styles.statValue, { color: theme.colors.accent.champagneDeep }]}>
          ${totalSpent.toFixed(0)}
        </Text>
        <Text style={styles.statLabel}>Spent</Text>
      </View>
    </View>
  );
}

function GuestView({ styles, theme }: { styles: ReturnType<typeof createStyles>; theme: Theme }) {
  return (
    <View style={styles.guestContainer} testID="guest-view">
      <View style={styles.guestIconWrap}>
        <Ionicons name="person-outline" size={36} color={theme.colors.accent.champagneDeep} />
      </View>
      <Text style={styles.guestTitle}>Welcome to Ennio</Text>
      <Text style={styles.guestSubtitle}>
        Sign in to access your profile, view orders, and curate your wishlist
      </Text>
      <Link href="/auth/login" asChild>
        <PressableScale style={styles.signInBtn} testID="guest-signin-btn">
          <Text style={styles.signInBtnText}>Sign In</Text>
        </PressableScale>
      </Link>
      <Link href="/auth/register" asChild>
        <PressableScale style={styles.createAccountBtn} testID="guest-register-btn">
          <Text style={styles.createAccountText}>Create Account</Text>
        </PressableScale>
      </Link>
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const logout = useAuthStore((state) => state.logout);
  const hapticEnabled = useSettingsStore((state) => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore((state) => state.preferences.darkMode);
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const TAB_BAR_HEIGHT = 49;

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          logout();
          if (hapticEnabled) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          }
        },
      },
    ]);
  };

  if (!isAuthenticated) {
    return (
      <View
        style={{ flex: 1, backgroundColor: theme.colors.background.primary }}
        testID="profile-root"
      >
        <GuestView styles={styles} theme={theme} />
      </View>
    );
  }

  return (
    <View
      style={{ flex: 1, backgroundColor: theme.colors.background.primary }}
      testID="profile-root"
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 16 }}
        contentInsetAdjustmentBehavior="automatic"
        testID="profile-screen"
      >
        <ProfileHeader styles={styles} theme={theme} />
        <StatsCard styles={styles} theme={theme} />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="cube-outline"
              label="Order History"
              onPress={() => router.push('/orders')}
              testID="menu-orders"
              styles={styles}
              theme={theme}
            />
            <MenuItem
              icon="card-outline"
              label="Payment Methods"
              value="•••• 4242"
              onPress={() => Alert.alert('Coming Soon', 'Payment methods will be available soon!')}
              testID="menu-payment"
              styles={styles}
              theme={theme}
            />
            <MenuItem
              icon="location-outline"
              label="Addresses"
              value="2 saved"
              onPress={() =>
                Alert.alert('Coming Soon', 'Address management will be available soon!')
              }
              testID="menu-addresses"
              styles={styles}
              theme={theme}
              isLast
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Preferences</Text>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="settings-outline"
              label="Settings"
              onPress={() => router.push('/settings')}
              testID="menu-settings"
              styles={styles}
              theme={theme}
            />
            <MenuItem
              icon="notifications-outline"
              label="Notifications"
              onPress={() => router.push('/settings')}
              testID="menu-notifications"
              styles={styles}
              theme={theme}
            />
            <MenuItem
              icon={darkMode ? 'moon-outline' : 'sunny-outline'}
              label="Appearance"
              value={darkMode ? 'Dark' : 'Light'}
              onPress={() => router.push('/settings')}
              testID="menu-appearance"
              styles={styles}
              theme={theme}
              isLast
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Support</Text>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="help-circle-outline"
              label="Help Center"
              onPress={() => Alert.alert('Help Center', 'How can we help you today?')}
              testID="menu-help"
              styles={styles}
              theme={theme}
            />
            <MenuItem
              icon="chatbubble-outline"
              label="Contact Us"
              onPress={() => Alert.alert('Contact', 'support@ennio.example')}
              testID="menu-contact"
              styles={styles}
              theme={theme}
            />
            <MenuItem
              icon="document-text-outline"
              label="Terms & Privacy"
              onPress={() => Alert.alert('Terms & Privacy', 'Read our terms and privacy policy.')}
              testID="menu-terms"
              styles={styles}
              theme={theme}
              isLast
            />
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="log-out-outline"
              label="Sign Out"
              onPress={handleLogout}
              testID="menu-logout"
              danger
              styles={styles}
              theme={theme}
              isLast
            />
          </View>
        </View>

        <Text style={styles.version}>Ennio · Version 1.0.0</Text>
      </ScrollView>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.primary,
    },

    profileHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.background.elevated,
      marginHorizontal: 16,
      marginTop: 8,
      padding: 18,
      borderRadius: theme.radii.lg,
      ...theme.shadows.soft,
    },
    avatar: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.colors.background.tonal,
    },
    profileInfo: {
      flex: 1,
      marginLeft: 14,
    },
    profileName: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.text.primary,
      letterSpacing: -0.3,
    },
    profileEmail: {
      fontSize: 13,
      color: theme.colors.text.muted,
      marginTop: 3,
    },
    editButton: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: theme.colors.background.tonal,
      alignItems: 'center',
      justifyContent: 'center',
    },

    statsCard: {
      flexDirection: 'row',
      backgroundColor: theme.colors.background.elevated,
      marginHorizontal: 16,
      marginTop: 12,
      paddingVertical: 20,
      borderRadius: theme.radii.lg,
      ...theme.shadows.soft,
    },
    statItem: {
      flex: 1,
      alignItems: 'center',
    },
    statValue: {
      fontSize: 24,
      fontWeight: '700',
      color: theme.colors.text.primary,
      letterSpacing: -0.4,
    },
    statLabel: {
      fontSize: 11,
      color: theme.colors.text.muted,
      marginTop: 4,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      fontWeight: '600',
    },
    statDivider: {
      width: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.divider,
      marginVertical: 4,
    },

    section: {
      marginTop: 22,
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: '700',
      color: theme.colors.text.muted,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      marginHorizontal: 22,
      marginBottom: 10,
    },
    menuGroup: {
      backgroundColor: theme.colors.background.elevated,
      marginHorizontal: 16,
      borderRadius: theme.radii.lg,
      overflow: 'hidden',
      ...theme.shadows.soft,
    },
    menuItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.divider,
    },
    menuItemLast: {
      borderBottomWidth: 0,
    },
    menuItemLeft: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    menuIconWrap: {
      width: 32,
      height: 32,
      borderRadius: theme.radii.sm,
      backgroundColor: theme.colors.background.tonal,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 14,
    },
    menuIconWrapDanger: {
      backgroundColor: theme.isDark ? 'rgba(213,91,79,0.14)' : 'rgba(184,58,46,0.08)',
    },
    menuLabel: {
      fontSize: 15,
      color: theme.colors.text.primary,
      fontWeight: '500',
    },
    menuItemRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    menuValue: {
      fontSize: 13,
      color: theme.colors.text.muted,
    },
    dangerText: {
      color: theme.colors.danger,
    },
    version: {
      textAlign: 'center',
      color: theme.colors.text.muted,
      fontSize: 11,
      marginVertical: 26,
      letterSpacing: 0.4,
    },

    guestContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
    },
    guestIconWrap: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: theme.colors.background.tonal,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 22,
      ...theme.shadows.soft,
    },
    guestTitle: {
      fontSize: 26,
      fontWeight: '700',
      color: theme.colors.text.primary,
      marginBottom: 10,
      textAlign: 'center',
      letterSpacing: -0.5,
    },
    guestSubtitle: {
      fontSize: 14,
      color: theme.colors.text.muted,
      textAlign: 'center',
      lineHeight: 21,
      marginBottom: 30,
      maxWidth: 300,
    },
    signInBtn: {
      backgroundColor: theme.colors.accent.ink,
      paddingHorizontal: 56,
      paddingVertical: 14,
      borderRadius: theme.radii.pill,
      marginBottom: 14,
    },
    signInBtnText: {
      color: theme.colors.text.onAccent,
      fontWeight: '600',
      fontSize: 15,
      letterSpacing: 0.3,
    },
    createAccountBtn: {
      paddingVertical: 10,
    },
    createAccountText: {
      color: theme.colors.text.primary,
      fontWeight: '600',
      fontSize: 14,
      textDecorationLine: 'underline',
    },
  });
