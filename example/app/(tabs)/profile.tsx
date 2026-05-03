import { View, Text, StyleSheet, ScrollView, Pressable, Image, Alert } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useAuthStore, useCartStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';

function MenuItem({
  icon,
  label,
  value,
  onPress,
  testID,
  danger = false,
}: {
  icon: string;
  label: string;
  value?: string;
  onPress: () => void;
  testID: string;
  danger?: boolean;
}) {
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <Pressable
      style={[styles.menuItem, darkMode && styles.menuItemDark]}
      onPress={onPress}
      testID={testID}
    >
      <View style={styles.menuItemLeft}>
        <Text style={styles.menuIcon}>{icon}</Text>
        <Text style={[styles.menuLabel, darkMode && styles.textLight, danger && styles.dangerText]}>
          {label}
        </Text>
      </View>
      <View style={styles.menuItemRight}>
        {value && <Text style={[styles.menuValue, darkMode && styles.subtitleDark]}>{value}</Text>}
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

function ProfileHeader() {
  const user = useAuthStore(state => state.user);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <View style={[styles.profileHeader, darkMode && styles.cardDark]} testID="profile-header">
      <Image
        source={{ uri: user?.avatar || 'https://i.pravatar.cc/150' }}
        style={styles.avatar}
      />
      <View style={styles.profileInfo}>
        <Text style={[styles.profileName, darkMode && styles.textLight]}>{user?.name}</Text>
        <Text style={[styles.profileEmail, darkMode && styles.subtitleDark]}>{user?.email}</Text>
      </View>
      <Link href="/settings" asChild>
        <Pressable style={styles.editButton} testID="edit-profile-btn">
          <Text style={styles.editButtonText}>Edit</Text>
        </Pressable>
      </Link>
    </View>
  );
}

function StatsCard() {
  const orders = useCartStore(state => state.orders);
  const items = useCartStore(state => state.items);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  const totalSpent = orders.reduce((sum, order) => sum + order.total, 0);

  return (
    <View style={[styles.statsCard, darkMode && styles.cardDark]} testID="stats-card">
      <View style={styles.statItem}>
        <Text style={styles.statValue}>{orders.length}</Text>
        <Text style={[styles.statLabel, darkMode && styles.subtitleDark]}>Orders</Text>
      </View>
      <View style={[styles.statDivider, darkMode && styles.dividerDark]} />
      <View style={styles.statItem}>
        <Text style={styles.statValue}>{items.length}</Text>
        <Text style={[styles.statLabel, darkMode && styles.subtitleDark]}>In Cart</Text>
      </View>
      <View style={[styles.statDivider, darkMode && styles.dividerDark]} />
      <View style={styles.statItem}>
        <Text style={styles.statValue}>${totalSpent.toFixed(0)}</Text>
        <Text style={[styles.statLabel, darkMode && styles.subtitleDark]}>Spent</Text>
      </View>
    </View>
  );
}

function GuestView() {
  const router = useRouter();
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <View style={[styles.guestContainer, darkMode && styles.containerDark]} testID="guest-view">
      <Text style={styles.guestIcon}>👤</Text>
      <Text style={[styles.guestTitle, darkMode && styles.textLight]}>Welcome to Ennio Shop</Text>
      <Text style={[styles.guestSubtitle, darkMode && styles.subtitleDark]}>
        Sign in to access your profile, view orders, and more
      </Text>
      <Link href="/auth/login" asChild>
        <Pressable style={styles.signInBtn} testID="guest-signin-btn">
          <Text style={styles.signInBtnText}>Sign In</Text>
        </Pressable>
      </Link>
      <Link href="/auth/register" asChild>
        <Pressable style={styles.createAccountBtn} testID="guest-register-btn">
          <Text style={[styles.createAccountText, darkMode && styles.textLight]}>Create Account</Text>
        </Pressable>
      </Link>
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const logout = useAuthStore(state => state.logout);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

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
            if (hapticEnabled) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            }
          },
        },
      ]
    );
  };

  if (!isAuthenticated) {
    return <GuestView />;
  }

  return (
    <ScrollView
      style={[styles.container, darkMode && styles.containerDark]}
      testID="profile-screen"
    >
      <ProfileHeader />
      <StatsCard />

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Account</Text>
        <MenuItem
          icon="📦"
          label="Order History"
          value=""
          onPress={() => router.push('/orders')}
          testID="menu-orders"
        />
        <MenuItem
          icon="💳"
          label="Payment Methods"
          value="•••• 4242"
          onPress={() => Alert.alert('Coming Soon', 'Payment methods will be available soon!')}
          testID="menu-payment"
        />
        <MenuItem
          icon="📍"
          label="Addresses"
          value="2 saved"
          onPress={() => Alert.alert('Coming Soon', 'Address management will be available soon!')}
          testID="menu-addresses"
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Preferences</Text>
        <MenuItem
          icon="⚙️"
          label="Settings"
          onPress={() => router.push('/settings')}
          testID="menu-settings"
        />
        <MenuItem
          icon="🔔"
          label="Notifications"
          onPress={() => router.push('/settings')}
          testID="menu-notifications"
        />
        <MenuItem
          icon={darkMode ? '🌙' : '☀️'}
          label="Appearance"
          value={darkMode ? 'Dark' : 'Light'}
          onPress={() => router.push('/settings')}
          testID="menu-appearance"
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Support</Text>
        <MenuItem
          icon="❓"
          label="Help Center"
          onPress={() => Alert.alert('Help Center', 'How can we help you today?')}
          testID="menu-help"
        />
        <MenuItem
          icon="💬"
          label="Contact Us"
          onPress={() => Alert.alert('Contact', 'support@ennio.example')}
          testID="menu-contact"
        />
        <MenuItem
          icon="📄"
          label="Terms & Privacy"
          onPress={() => Alert.alert('Terms & Privacy', 'Read our terms and privacy policy.')}
          testID="menu-terms"
        />
      </View>

      <View style={styles.section}>
        <MenuItem
          icon="🚪"
          label="Sign Out"
          onPress={handleLogout}
          testID="menu-logout"
          danger
        />
      </View>

      <Text style={[styles.version, darkMode && styles.subtitleDark]}>Version 1.0.0</Text>
    </ScrollView>
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
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    margin: 15,
    padding: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  cardDark: {
    backgroundColor: '#1a1a2e',
  },
  textLight: {
    color: '#fff',
  },
  subtitleDark: {
    color: '#aaa',
  },
  avatar: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: '#f0f0f0',
  },
  profileInfo: {
    flex: 1,
    marginLeft: 16,
  },
  profileName: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  profileEmail: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  editButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
  },
  editButtonText: {
    color: '#007AFF',
    fontWeight: '600',
  },
  statsCard: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    marginHorizontal: 15,
    marginBottom: 20,
    padding: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  statLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  statDivider: {
    width: 1,
    backgroundColor: '#e0e0e0',
  },
  dividerDark: {
    backgroundColor: '#2a2a3e',
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginHorizontal: 15,
    marginBottom: 10,
  },
  menuItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 15,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  menuItemDark: {
    backgroundColor: '#1a1a2e',
    borderBottomColor: '#2a2a3e',
  },
  menuItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  menuLabel: {
    fontSize: 16,
    color: '#1a1a2e',
  },
  menuItemRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuValue: {
    fontSize: 14,
    color: '#999',
    marginRight: 8,
  },
  chevron: {
    fontSize: 20,
    color: '#ccc',
  },
  dangerText: {
    color: '#FF3B30',
  },
  version: {
    textAlign: 'center',
    color: '#999',
    fontSize: 12,
    marginVertical: 20,
  },
  guestContainer: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  guestIcon: {
    fontSize: 80,
    marginBottom: 20,
  },
  guestTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 10,
    textAlign: 'center',
  },
  guestSubtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  signInBtn: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 50,
    paddingVertical: 14,
    borderRadius: 25,
    marginBottom: 15,
  },
  signInBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  createAccountBtn: {
    paddingVertical: 10,
  },
  createAccountText: {
    color: '#007AFF',
    fontWeight: '600',
    fontSize: 15,
  },
});
