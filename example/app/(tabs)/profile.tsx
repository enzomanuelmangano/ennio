import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  Alert,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore, useCartStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, lineHeight, radius } from '../../src/theme';

type Palette = ReturnType<typeof colors>;

function MenuItem({
  symbol,
  tint,
  label,
  value,
  onPress,
  testID,
  danger = false,
  c,
  isLast,
}: {
  symbol: string;
  tint: string;
  label: string;
  value?: string;
  onPress: () => void;
  testID: string;
  danger?: boolean;
  c: Palette;
  isLast: boolean;
}) {
  return (
    <View>
      <PressableScale
        style={styles.menuItem}
        onPress={onPress}
        testID={testID}
      >
        <View style={[styles.menuIconBg, { backgroundColor: tint + '22' }]}>
          <Text style={[styles.menuIcon, { color: tint }]}>{symbol}</Text>
        </View>
        <Text
          style={[
            styles.menuLabel,
            { color: danger ? c.systemRed : c.label },
          ]}
        >
          {label}
        </Text>
        <View style={styles.menuItemRight}>
          {value !== undefined && value !== '' && (
            <Text style={[styles.menuValue, { color: c.secondaryLabel }]}>
              {value}
            </Text>
          )}
          {!danger && (
            <Text style={[styles.chevron, { color: c.tertiaryLabel }]}>›</Text>
          )}
        </View>
      </PressableScale>
      {!isLast && (
        <View
          style={[
            styles.menuSeparator,
            { backgroundColor: c.separator },
          ]}
        />
      )}
    </View>
  );
}

function ProfileHeader({ c }: { c: Palette }) {
  const user = useAuthStore(state => state.user);

  return (
    <View
      style={[
        styles.profileHeader,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ]}
      testID="profile-header"
    >
      <Image
        source={{ uri: user?.avatar || 'https://i.pravatar.cc/150' }}
        style={styles.avatar}
      />
      <View style={styles.profileInfo}>
        <Text style={[styles.profileName, { color: c.label }]}>
          {user?.name}
        </Text>
        <Text style={[styles.profileEmail, { color: c.secondaryLabel }]}>
          {user?.email}
        </Text>
      </View>
      <Link href="/settings" asChild>
        <PressableScale
          style={StyleSheet.flatten([
            styles.editButton,
            { backgroundColor: c.tertiarySystemFill },
          ])}
          testID="edit-profile-btn"
        >
          <Text style={[styles.editButtonText, { color: c.systemBlue }]}>
            Edit
          </Text>
        </PressableScale>
      </Link>
    </View>
  );
}

function StatsCard({ c }: { c: Palette }) {
  const orders = useCartStore(state => state.orders);
  const items = useCartStore(state => state.items);

  const totalSpent = orders.reduce((sum, order) => sum + order.total, 0);

  return (
    <View
      style={[
        styles.statsCard,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ]}
      testID="stats-card"
    >
      <View style={styles.statItem}>
        <Text style={[styles.statValue, { color: c.label }]}>
          {orders.length}
        </Text>
        <Text style={[styles.statLabel, { color: c.secondaryLabel }]}>
          Orders
        </Text>
      </View>
      <View style={[styles.statDivider, { backgroundColor: c.separator }]} />
      <View style={styles.statItem}>
        <Text style={[styles.statValue, { color: c.label }]}>
          {items.length}
        </Text>
        <Text style={[styles.statLabel, { color: c.secondaryLabel }]}>
          In Cart
        </Text>
      </View>
      <View style={[styles.statDivider, { backgroundColor: c.separator }]} />
      <View style={styles.statItem}>
        <Text style={[styles.statValue, { color: c.label }]}>
          ${totalSpent.toFixed(0)}
        </Text>
        <Text style={[styles.statLabel, { color: c.secondaryLabel }]}>
          Spent
        </Text>
      </View>
    </View>
  );
}

function GuestView({ c }: { c: Palette }) {
  return (
    <View
      style={StyleSheet.flatten([
        styles.guestContainer,
        { backgroundColor: c.systemGroupedBackground },
      ])}
      testID="guest-view"
    >
      <View
        style={StyleSheet.flatten([
          styles.guestIconBg,
          { backgroundColor: c.systemBlue + '22' },
        ])}
      >
        <Text
          style={StyleSheet.flatten([
            styles.guestIcon,
            { color: c.systemBlue },
          ])}
        >
          ◔
        </Text>
      </View>
      <Text
        style={StyleSheet.flatten([
          styles.guestTitle,
          { color: c.label },
        ])}
      >
        Welcome to Ennio Shop
      </Text>
      <Text
        style={StyleSheet.flatten([
          styles.guestSubtitle,
          { color: c.secondaryLabel },
        ])}
      >
        Sign in to access your profile, view orders, and more
      </Text>
      <Link href="/auth/login" asChild>
        <PressableScale
          style={StyleSheet.flatten([styles.signInBtn, { backgroundColor: c.systemBlue }])}
          testID="guest-signin-btn"
        >
          <Text style={styles.signInBtnText}>Sign In</Text>
        </PressableScale>
      </Link>
      <Link href="/auth/register" asChild>
        <PressableScale
          style={styles.createAccountBtn}
          testID="guest-register-btn"
        >
          <Text
            style={StyleSheet.flatten([
              styles.createAccountText,
              { color: c.systemBlue },
            ])}
          >
            Create Account
          </Text>
        </PressableScale>
      </Link>
    </View>
  );
}

function SectionTitle({ title, c }: { title: string; c: Palette }) {
  return (
    <Text style={[styles.sectionTitle, { color: c.secondaryLabel }]}>
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
        styles.groupedSection,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ]}
    >
      {children}
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const logout = useAuthStore(state => state.logout);
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);
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
    return <GuestView c={c} />;
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.systemGroupedBackground }}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
      }}
      showsVerticalScrollIndicator={false}
      testID="profile-screen"
    >
      <Text style={[styles.largeTitle, { color: c.label }]}>Profile</Text>

      <ProfileHeader c={c} />
      <StatsCard c={c} />

      <SectionTitle title="ACCOUNT" c={c} />
      <GroupedSection c={c}>
        <MenuItem
          symbol="◫"
          tint={c.systemBlue}
          label="Order History"
          value=""
          onPress={() => router.push('/orders')}
          testID="menu-orders"
          c={c}
          isLast={false}
        />
        <MenuItem
          symbol="▭"
          tint={c.systemGreen}
          label="Payment Methods"
          value="•••• 4242"
          onPress={() =>
            Alert.alert('Coming Soon', 'Payment methods will be available soon!')
          }
          testID="menu-payment"
          c={c}
          isLast={false}
        />
        <MenuItem
          symbol="◉"
          tint={c.systemRed}
          label="Addresses"
          value="2 saved"
          onPress={() =>
            Alert.alert(
              'Coming Soon',
              'Address management will be available soon!',
            )
          }
          testID="menu-addresses"
          c={c}
          isLast={true}
        />
      </GroupedSection>

      <SectionTitle title="PREFERENCES" c={c} />
      <GroupedSection c={c}>
        <MenuItem
          symbol="⚙"
          tint={c.secondaryLabel}
          label="Settings"
          onPress={() => router.push('/settings')}
          testID="menu-settings"
          c={c}
          isLast={false}
        />
        <MenuItem
          symbol="◔"
          tint={c.systemOrange}
          label="Notifications"
          onPress={() => router.push('/settings')}
          testID="menu-notifications"
          c={c}
          isLast={false}
        />
        <MenuItem
          symbol={darkMode ? '☾' : '☀'}
          tint={c.systemPurple}
          label="Appearance"
          value={darkMode ? 'Dark' : 'Light'}
          onPress={() => router.push('/settings')}
          testID="menu-appearance"
          c={c}
          isLast={true}
        />
      </GroupedSection>

      <SectionTitle title="SUPPORT" c={c} />
      <GroupedSection c={c}>
        <MenuItem
          symbol="?"
          tint={c.systemTeal}
          label="Help Center"
          onPress={() => Alert.alert('Help Center', 'How can we help you today?')}
          testID="menu-help"
          c={c}
          isLast={false}
        />
        <MenuItem
          symbol="✉"
          tint={c.systemBlue}
          label="Contact Us"
          onPress={() => Alert.alert('Contact', 'support@ennio.example')}
          testID="menu-contact"
          c={c}
          isLast={false}
        />
        <MenuItem
          symbol="§"
          tint={c.systemIndigo}
          label="Terms & Privacy"
          onPress={() =>
            Alert.alert('Terms & Privacy', 'Read our terms and privacy policy.')
          }
          testID="menu-terms"
          c={c}
          isLast={true}
        />
      </GroupedSection>

      <GroupedSection c={c}>
        <MenuItem
          symbol="↩"
          tint={c.systemRed}
          label="Sign Out"
          onPress={handleLogout}
          testID="menu-logout"
          c={c}
          danger
          isLast={true}
        />
      </GroupedSection>

      <Text style={[styles.version, { color: c.tertiaryLabel }]}>
        Version 1.0.0
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  largeTitle: {
    fontSize: fontSize.largeTitle,
    lineHeight: lineHeight.largeTitle,
    fontWeight: '700',
    letterSpacing: 0.37,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    padding: 16,
    borderRadius: radius.card,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  profileInfo: {
    flex: 1,
    marginLeft: 14,
  },
  profileName: {
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  profileEmail: {
    fontSize: fontSize.footnote,
    marginTop: 2,
  },
  editButton: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  editButtonText: {
    fontWeight: '600',
    fontSize: fontSize.subhead,
  },
  statsCard: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: radius.card,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: fontSize.title2,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: fontSize.caption1,
    marginTop: 2,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
  },
  sectionTitle: {
    fontSize: fontSize.footnote,
    fontWeight: '400',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginHorizontal: 32,
    marginTop: 24,
    marginBottom: 8,
  },
  groupedSection: {
    marginHorizontal: 16,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  menuIconBg: {
    width: 30,
    height: 30,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  menuIcon: {
    fontSize: 16,
    fontWeight: '600',
  },
  menuLabel: {
    flex: 1,
    fontSize: fontSize.body,
  },
  menuItemRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuValue: {
    fontSize: fontSize.subhead,
    marginRight: 6,
  },
  chevron: {
    fontSize: 20,
    fontWeight: '500',
  },
  menuSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
  },
  version: {
    textAlign: 'center',
    fontSize: fontSize.caption1,
    marginTop: 24,
  },
  guestContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  guestIconBg: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  guestIcon: {
    fontSize: 50,
    fontWeight: '600',
  },
  guestTitle: {
    fontSize: fontSize.title2,
    fontWeight: '700',
    marginBottom: 10,
    textAlign: 'center',
  },
  guestSubtitle: {
    fontSize: fontSize.subhead,
    textAlign: 'center',
    lineHeight: lineHeight.subhead,
    marginBottom: 28,
  },
  signInBtn: {
    paddingHorizontal: 50,
    paddingVertical: 14,
    borderRadius: radius.pill,
    marginBottom: 14,
  },
  signInBtnText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: fontSize.body,
  },
  createAccountBtn: {
    paddingVertical: 8,
  },
  createAccountText: {
    fontWeight: '600',
    fontSize: fontSize.subhead,
  },
});
