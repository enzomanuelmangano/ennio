import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter, Stack } from 'expo-router';
import { useSettingsStore, useAuthStore, useCartStore } from '../store';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, lineHeight, radius } from '../src/theme';

type Palette = ReturnType<typeof colors>;

function SettingRow({
  symbol,
  tint,
  label,
  description,
  value,
  onToggle,
  c,
  testID,
  isLast,
}: {
  symbol: string;
  tint: string;
  label: string;
  description?: string;
  value: boolean;
  onToggle: (value: boolean) => void;
  c: Palette;
  testID: string;
  isLast: boolean;
}) {
  return (
    <View>
      <View style={styles.settingRow}>
        <View style={[styles.iconBg, { backgroundColor: tint + '22' }]}>
          <Text style={[styles.icon, { color: tint }]}>{symbol}</Text>
        </View>
        <View style={styles.settingContent}>
          <Text style={[styles.settingLabel, { color: c.label }]}>
            {label}
          </Text>
          {description && (
            <Text
              style={[styles.settingDescription, { color: c.secondaryLabel }]}
            >
              {description}
            </Text>
          )}
        </View>
        <Switch
          value={value}
          onValueChange={onToggle}
          trackColor={{ false: c.tertiarySystemFill, true: c.systemGreen }}
          thumbColor="#FFFFFF"
          ios_backgroundColor={c.tertiarySystemFill}
          testID={testID}
        />
      </View>
      {!isLast && (
        <View
          style={[
            styles.rowSeparator,
            { backgroundColor: c.separator },
          ]}
        />
      )}
    </View>
  );
}

function SettingButton({
  symbol,
  tint,
  label,
  value,
  onPress,
  c,
  testID,
  danger = false,
  isLast,
}: {
  symbol: string;
  tint: string;
  label: string;
  value?: string;
  onPress: () => void;
  c: Palette;
  testID: string;
  danger?: boolean;
  isLast: boolean;
}) {
  return (
    <View>
      <PressableScale
        style={styles.settingRow}
        onPress={onPress}
        testID={testID}
      >
        <View style={[styles.iconBg, { backgroundColor: tint + '22' }]}>
          <Text style={[styles.icon, { color: tint }]}>{symbol}</Text>
        </View>
        <Text
          style={[
            styles.settingLabel,
            styles.settingContent,
            { color: danger ? c.systemRed : c.label },
          ]}
        >
          {label}
        </Text>
        {value && (
          <Text style={[styles.settingValue, { color: c.secondaryLabel }]}>
            {value}
          </Text>
        )}
        {!danger && (
          <Text style={[styles.chevron, { color: c.tertiaryLabel }]}>›</Text>
        )}
      </PressableScale>
      {!isLast && (
        <View
          style={[
            styles.rowSeparator,
            { backgroundColor: c.separator },
          ]}
        />
      )}
    </View>
  );
}

function SectionHeader({ title, c }: { title: string; c: Palette }) {
  return (
    <Text style={[styles.sectionHeader, { color: c.secondaryLabel }]}>
      {title}
    </Text>
  );
}

function GroupedSection({
  c,
  children,
}: {
  c: Palette;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.section,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ]}
    >
      {children}
    </View>
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
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);

  const handleToggle = (
    key: string,
    value: boolean,
    type: 'pref' | 'notif' | 'privacy',
  ) => {
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
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
            }
          },
        },
      ],
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
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
            }
            Alert.alert('Done', 'All data has been cleared.');
          },
        },
      ],
    );
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          logout();
          router.back();
        },
      },
    ]);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerStyle: { backgroundColor: c.systemBackground },
          headerTintColor: c.label,
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.systemGroupedBackground }}
        contentContainerStyle={{ paddingBottom: 32 }}
        testID="settings-screen"
      >
        <SectionHeader title="APPEARANCE" c={c} />
        <GroupedSection c={c}>
          <SettingRow
            symbol="☾"
            tint={c.systemPurple}
            label="Dark Mode"
            description="Use dark theme throughout the app"
            value={preferences.darkMode}
            onToggle={v => handleToggle('darkMode', v, 'pref')}
            c={c}
            testID="toggle-dark-mode"
            isLast={false}
          />
          <SettingRow
            symbol="≈"
            tint={c.systemPink}
            label="Haptic Feedback"
            description="Vibrate on button presses"
            value={preferences.hapticFeedback}
            onToggle={v => handleToggle('hapticFeedback', v, 'pref')}
            c={c}
            testID="toggle-haptic"
            isLast={false}
          />
          <SettingRow
            symbol="◔"
            tint={c.systemOrange}
            label="Show Notifications Badge"
            value={preferences.showBadges}
            onToggle={v => handleToggle('showBadges', v, 'pref')}
            c={c}
            testID="toggle-badges"
            isLast={true}
          />
        </GroupedSection>

        <SectionHeader title="NOTIFICATIONS" c={c} />
        <GroupedSection c={c}>
          <SettingRow
            symbol="◫"
            tint={c.systemBlue}
            label="Order Updates"
            description="Get notified about order status changes"
            value={notifications.orderUpdates}
            onToggle={v => handleToggle('orderUpdates', v, 'notif')}
            c={c}
            testID="toggle-order-updates"
            isLast={false}
          />
          <SettingRow
            symbol="$"
            tint={c.systemGreen}
            label="Promotions"
            description="Receive deals and promotional offers"
            value={notifications.promotions}
            onToggle={v => handleToggle('promotions', v, 'notif')}
            c={c}
            testID="toggle-promotions"
            isLast={false}
          />
          <SettingRow
            symbol="✦"
            tint={c.systemTeal}
            label="New Arrivals"
            description="Be notified when new products are added"
            value={notifications.newArrivals}
            onToggle={v => handleToggle('newArrivals', v, 'notif')}
            c={c}
            testID="toggle-new-arrivals"
            isLast={false}
          />
          <SettingRow
            symbol="↓"
            tint={c.systemIndigo}
            label="Price Drops"
            description="Get alerts when saved items go on sale"
            value={notifications.priceDrops}
            onToggle={v => handleToggle('priceDrops', v, 'notif')}
            c={c}
            testID="toggle-price-drops"
            isLast={true}
          />
        </GroupedSection>

        <SectionHeader title="PRIVACY" c={c} />
        <GroupedSection c={c}>
          <SettingRow
            symbol="◯"
            tint={c.systemBlue}
            label="Analytics"
            description="Help us improve by sharing anonymous usage data"
            value={privacy.analytics}
            onToggle={v => handleToggle('analytics', v, 'privacy')}
            c={c}
            testID="toggle-analytics"
            isLast={false}
          />
          <SettingRow
            symbol="◎"
            tint={c.systemPurple}
            label="Personalized Ads"
            description="See ads based on your interests"
            value={privacy.personalizedAds}
            onToggle={v => handleToggle('personalizedAds', v, 'privacy')}
            c={c}
            testID="toggle-personalized-ads"
            isLast={false}
          />
          <SettingRow
            symbol="◉"
            tint={c.systemRed}
            label="Location Services"
            description="Allow location access for local deals"
            value={privacy.locationServices}
            onToggle={v => handleToggle('locationServices', v, 'privacy')}
            c={c}
            testID="toggle-location"
            isLast={true}
          />
        </GroupedSection>

        <SectionHeader title="ACCOUNT" c={c} />
        <GroupedSection c={c}>
          {isAuthenticated ? (
            <>
              <SettingButton
                symbol="◔"
                tint={c.systemBlue}
                label="Edit Profile"
                onPress={() =>
                  Alert.alert(
                    'Coming Soon',
                    'Profile editing will be available soon!',
                  )
                }
                c={c}
                testID="edit-profile"
                isLast={false}
              />
              <SettingButton
                symbol="⌬"
                tint={c.systemTeal}
                label="Change Password"
                onPress={() =>
                  Alert.alert(
                    'Coming Soon',
                    'Password change will be available soon!',
                  )
                }
                c={c}
                testID="change-password"
                isLast={false}
              />
              <SettingButton
                symbol="↩"
                tint={c.systemRed}
                label="Sign Out"
                onPress={handleLogout}
                c={c}
                testID="sign-out"
                danger
                isLast={true}
              />
            </>
          ) : (
            <SettingButton
              symbol="↪"
              tint={c.systemBlue}
              label="Sign In"
              onPress={() => router.push('/auth/login')}
              c={c}
              testID="sign-in"
              isLast={true}
            />
          )}
        </GroupedSection>

        <SectionHeader title="ABOUT" c={c} />
        <GroupedSection c={c}>
          <SettingButton
            symbol="ℹ"
            tint={c.systemBlue}
            label="App Version"
            value="1.0.0"
            onPress={() => {}}
            c={c}
            testID="app-version"
            isLast={false}
          />
          <SettingButton
            symbol="§"
            tint={c.systemIndigo}
            label="Terms of Service"
            onPress={() =>
              Alert.alert('Terms of Service', 'Terms content here...')
            }
            c={c}
            testID="terms"
            isLast={false}
          />
          <SettingButton
            symbol="🔒"
            tint={c.systemPurple}
            label="Privacy Policy"
            onPress={() =>
              Alert.alert('Privacy Policy', 'Privacy content here...')
            }
            c={c}
            testID="privacy-policy"
            isLast={false}
          />
          <SettingButton
            symbol="?"
            tint={c.systemTeal}
            label="Help & Support"
            onPress={() =>
              Alert.alert('Help', 'Contact us at support@ennio.example')
            }
            c={c}
            testID="help"
            isLast={true}
          />
        </GroupedSection>

        <SectionHeader title="DATA" c={c} />
        <GroupedSection c={c}>
          <SettingButton
            symbol="✕"
            tint={c.systemRed}
            label="Clear Cart & Orders"
            onPress={handleClearData}
            c={c}
            testID="clear-data"
            danger
            isLast={false}
          />
          <SettingButton
            symbol="↺"
            tint={c.systemRed}
            label="Reset Settings"
            onPress={handleResetSettings}
            c={c}
            testID="reset-settings"
            danger
            isLast={true}
          />
        </GroupedSection>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    fontSize: fontSize.footnote,
    lineHeight: lineHeight.footnote,
    fontWeight: '400',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 8,
  },
  section: {
    marginHorizontal: 16,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 50,
  },
  iconBg: {
    width: 30,
    height: 30,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  icon: {
    fontSize: 16,
    fontWeight: '600',
  },
  settingContent: {
    flex: 1,
  },
  settingLabel: {
    fontSize: fontSize.body,
  },
  settingDescription: {
    fontSize: fontSize.caption1,
    lineHeight: lineHeight.caption1,
    marginTop: 1,
  },
  settingValue: {
    fontSize: fontSize.subhead,
    marginRight: 6,
  },
  chevron: {
    fontSize: 20,
    fontWeight: '500',
  },
  rowSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
  },
});
