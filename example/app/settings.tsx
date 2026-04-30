import { View, Text, StyleSheet, ScrollView, Pressable, Switch, Alert } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSettingsStore, useAuthStore, useCartStore } from '../store';
import * as Haptics from 'expo-haptics';

function SettingRow({
  icon,
  label,
  description,
  value,
  onToggle,
  darkMode,
  testID,
}: {
  icon: string;
  label: string;
  description?: string;
  value: boolean;
  onToggle: (value: boolean) => void;
  darkMode: boolean;
  testID: string;
}) {
  return (
    <View style={[styles.settingRow, darkMode && styles.settingRowDark]}>
      <Text style={styles.settingIcon}>{icon}</Text>
      <View style={styles.settingContent}>
        <Text style={[styles.settingLabel, darkMode && styles.textLight]}>{label}</Text>
        {description && (
          <Text style={[styles.settingDescription, darkMode && styles.subtitleDark]}>
            {description}
          </Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: '#e0e0e0', true: '#007AFF' }}
        thumbColor="#fff"
        testID={testID}
      />
    </View>
  );
}

function SettingButton({
  icon,
  label,
  value,
  onPress,
  darkMode,
  testID,
  danger = false,
}: {
  icon: string;
  label: string;
  value?: string;
  onPress: () => void;
  darkMode: boolean;
  testID: string;
  danger?: boolean;
}) {
  return (
    <Pressable
      style={[styles.settingRow, darkMode && styles.settingRowDark]}
      onPress={onPress}
      testID={testID}
    >
      <Text style={styles.settingIcon}>{icon}</Text>
      <View style={styles.settingContent}>
        <Text style={[
          styles.settingLabel,
          darkMode && styles.textLight,
          danger && styles.dangerText,
        ]}>
          {label}
        </Text>
      </View>
      {value && <Text style={[styles.settingValue, darkMode && styles.subtitleDark]}>{value}</Text>}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function SectionHeader({ title, darkMode }: { title: string; darkMode: boolean }) {
  return (
    <Text style={[styles.sectionHeader, darkMode && styles.subtitleDark]}>{title}</Text>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const preferences = useSettingsStore(state => state.preferences);
  const notifications = useSettingsStore(state => state.notifications);
  const privacy = useSettingsStore(state => state.privacy);
  const updatePreference = useSettingsStore(state => state.updatePreference);
  const updateNotification = useSettingsStore(state => state.updateNotification);
  const updatePrivacy = useSettingsStore(state => state.updatePrivacy);
  const resetSettings = useSettingsStore(state => state.resetSettings);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const logout = useAuthStore(state => state.logout);
  const clearCart = useCartStore(state => state.clearCart);

  const darkMode = preferences.darkMode;

  const handleToggle = (key: string, value: boolean, type: 'pref' | 'notif' | 'privacy') => {
    if (preferences.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (type === 'pref') {
      updatePreference(key as keyof typeof preferences, value);
    } else if (type === 'notif') {
      updateNotification(key as keyof typeof notifications, value);
    } else {
      updatePrivacy(key as keyof typeof privacy, value);
    }
  };

  const handleResetSettings = () => {
    Alert.alert(
      'Reset Settings',
      'This will reset all settings to their default values. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            resetSettings();
            if (preferences.hapticFeedback) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            }
          },
        },
      ]
    );
  };

  const handleClearData = () => {
    Alert.alert(
      'Clear All Data',
      'This will clear your cart and order history. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            clearCart();
            if (preferences.hapticFeedback) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            }
            Alert.alert('Done', 'All data has been cleared.');
          },
        },
      ]
    );
  };

  const handleLogout = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => {
            logout();
            router.back();
          },
        },
      ]
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerStyle: { backgroundColor: darkMode ? '#1a1a2e' : '#ffffff' },
          headerTintColor: darkMode ? '#ffffff' : '#000000',
        }}
      />
      <ScrollView
        style={[styles.container, darkMode && styles.containerDark]}
        testID="settings-screen"
      >
        {/* Appearance */}
        <SectionHeader title="Appearance" darkMode={darkMode} />
        <View style={[styles.section, darkMode && styles.sectionDark]}>
          <SettingRow
            icon="🌙"
            label="Dark Mode"
            description="Use dark theme throughout the app"
            value={preferences.darkMode}
            onToggle={v => handleToggle('darkMode', v, 'pref')}
            darkMode={darkMode}
            testID="toggle-dark-mode"
          />
          <SettingRow
            icon="📳"
            label="Haptic Feedback"
            description="Vibrate on button presses"
            value={preferences.hapticFeedback}
            onToggle={v => handleToggle('hapticFeedback', v, 'pref')}
            darkMode={darkMode}
            testID="toggle-haptic"
          />
          <SettingRow
            icon="🔔"
            label="Show Notifications Badge"
            value={preferences.showBadges}
            onToggle={v => handleToggle('showBadges', v, 'pref')}
            darkMode={darkMode}
            testID="toggle-badges"
          />
        </View>

        {/* Notifications */}
        <SectionHeader title="Notifications" darkMode={darkMode} />
        <View style={[styles.section, darkMode && styles.sectionDark]}>
          <SettingRow
            icon="📦"
            label="Order Updates"
            description="Get notified about order status changes"
            value={notifications.orderUpdates}
            onToggle={v => handleToggle('orderUpdates', v, 'notif')}
            darkMode={darkMode}
            testID="toggle-order-updates"
          />
          <SettingRow
            icon="💰"
            label="Promotions"
            description="Receive deals and promotional offers"
            value={notifications.promotions}
            onToggle={v => handleToggle('promotions', v, 'notif')}
            darkMode={darkMode}
            testID="toggle-promotions"
          />
          <SettingRow
            icon="📰"
            label="New Arrivals"
            description="Be notified when new products are added"
            value={notifications.newArrivals}
            onToggle={v => handleToggle('newArrivals', v, 'notif')}
            darkMode={darkMode}
            testID="toggle-new-arrivals"
          />
          <SettingRow
            icon="🔖"
            label="Price Drops"
            description="Get alerts when saved items go on sale"
            value={notifications.priceDrops}
            onToggle={v => handleToggle('priceDrops', v, 'notif')}
            darkMode={darkMode}
            testID="toggle-price-drops"
          />
        </View>

        {/* Privacy */}
        <SectionHeader title="Privacy" darkMode={darkMode} />
        <View style={[styles.section, darkMode && styles.sectionDark]}>
          <SettingRow
            icon="📊"
            label="Analytics"
            description="Help us improve by sharing anonymous usage data"
            value={privacy.analytics}
            onToggle={v => handleToggle('analytics', v, 'privacy')}
            darkMode={darkMode}
            testID="toggle-analytics"
          />
          <SettingRow
            icon="🎯"
            label="Personalized Ads"
            description="See ads based on your interests"
            value={privacy.personalizedAds}
            onToggle={v => handleToggle('personalizedAds', v, 'privacy')}
            darkMode={darkMode}
            testID="toggle-personalized-ads"
          />
          <SettingRow
            icon="📍"
            label="Location Services"
            description="Allow location access for local deals"
            value={privacy.locationServices}
            onToggle={v => handleToggle('locationServices', v, 'privacy')}
            darkMode={darkMode}
            testID="toggle-location"
          />
        </View>

        {/* Account */}
        <SectionHeader title="Account" darkMode={darkMode} />
        <View style={[styles.section, darkMode && styles.sectionDark]}>
          {isAuthenticated ? (
            <>
              <SettingButton
                icon="👤"
                label="Edit Profile"
                onPress={() => Alert.alert('Coming Soon', 'Profile editing will be available soon!')}
                darkMode={darkMode}
                testID="edit-profile"
              />
              <SettingButton
                icon="🔑"
                label="Change Password"
                onPress={() => Alert.alert('Coming Soon', 'Password change will be available soon!')}
                darkMode={darkMode}
                testID="change-password"
              />
              <SettingButton
                icon="🚪"
                label="Sign Out"
                onPress={handleLogout}
                darkMode={darkMode}
                testID="sign-out"
                danger
              />
            </>
          ) : (
            <SettingButton
              icon="🔐"
              label="Sign In"
              onPress={() => router.push('/auth/login')}
              darkMode={darkMode}
              testID="sign-in"
            />
          )}
        </View>

        {/* About */}
        <SectionHeader title="About" darkMode={darkMode} />
        <View style={[styles.section, darkMode && styles.sectionDark]}>
          <SettingButton
            icon="📱"
            label="App Version"
            value="1.0.0"
            onPress={() => {}}
            darkMode={darkMode}
            testID="app-version"
          />
          <SettingButton
            icon="📄"
            label="Terms of Service"
            onPress={() => Alert.alert('Terms of Service', 'Terms content here...')}
            darkMode={darkMode}
            testID="terms"
          />
          <SettingButton
            icon="🔒"
            label="Privacy Policy"
            onPress={() => Alert.alert('Privacy Policy', 'Privacy content here...')}
            darkMode={darkMode}
            testID="privacy-policy"
          />
          <SettingButton
            icon="❓"
            label="Help & Support"
            onPress={() => Alert.alert('Help', 'Contact us at support@tasto.example')}
            darkMode={darkMode}
            testID="help"
          />
        </View>

        {/* Data */}
        <SectionHeader title="Data" darkMode={darkMode} />
        <View style={[styles.section, darkMode && styles.sectionDark]}>
          <SettingButton
            icon="🗑️"
            label="Clear Cart & Orders"
            onPress={handleClearData}
            darkMode={darkMode}
            testID="clear-data"
            danger
          />
          <SettingButton
            icon="↺"
            label="Reset All Settings"
            onPress={handleResetSettings}
            darkMode={darkMode}
            testID="reset-settings"
            danger
          />
        </View>

        <View style={styles.bottomPadding} />
      </ScrollView>
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
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  section: {
    backgroundColor: '#fff',
  },
  sectionDark: {
    backgroundColor: '#1a1a2e',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    backgroundColor: '#fff',
  },
  settingRowDark: {
    backgroundColor: '#1a1a2e',
    borderBottomColor: '#2a2a3e',
  },
  settingIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  settingContent: {
    flex: 1,
  },
  settingLabel: {
    fontSize: 16,
    color: '#1a1a2e',
  },
  settingDescription: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  settingValue: {
    fontSize: 14,
    color: '#999',
    marginRight: 8,
  },
  textLight: {
    color: '#fff',
  },
  subtitleDark: {
    color: '#aaa',
  },
  dangerText: {
    color: '#FF3B30',
  },
  chevron: {
    fontSize: 20,
    color: '#ccc',
  },
  bottomPadding: {
    height: 40,
  },
});
