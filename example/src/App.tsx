import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  FlatList,
  Modal,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  Pressable,
  RefreshControl,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

type Screen = 'home' | 'form' | 'list' | 'modal';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('home');

  const navigateTo = (screen: Screen) => setCurrentScreen(screen);
  const goHome = () => setCurrentScreen('home');

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      {currentScreen === 'home' && <HomeScreen onNavigate={navigateTo} />}
      {currentScreen === 'form' && <FormScreen onBack={goHome} />}
      {currentScreen === 'list' && <ListScreen onBack={goHome} />}
      {currentScreen === 'modal' && <ModalScreen onBack={goHome} />}
    </SafeAreaView>
  );
}

// ============================================
// Home Screen
// ============================================

interface HomeScreenProps {
  onNavigate: (screen: Screen) => void;
}

function HomeScreen({ onNavigate }: HomeScreenProps) {
  return (
    <View style={styles.screen} testID="home-screen">
      <Text style={styles.title} testID="home-title">
        Welcome to Ennio
      </Text>

      <Text style={styles.subtitle} testID="home-subtitle">
        Fast React Native E2E Testing
      </Text>

      <View style={styles.buttons}>
        <TouchableOpacity
          style={styles.button}
          testID="nav-form-btn"
          onPress={() => onNavigate('form')}
        >
          <Text style={styles.buttonText}>Form Demo</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          testID="nav-list-btn"
          onPress={() => onNavigate('list')}
        >
          <Text style={styles.buttonText}>List Demo</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          testID="nav-modal-btn"
          onPress={() => onNavigate('modal')}
        >
          <Text style={styles.buttonText}>Modal Demo</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.infoBox} testID="info-box">
        <Text style={styles.infoText}>
          This example app demonstrates all the E2E testing capabilities of Ennio.
        </Text>
      </View>
    </View>
  );
}

// ============================================
// Form Screen
// ============================================

interface FormScreenProps {
  onBack: () => void;
}

interface FormErrors {
  email?: string;
  password?: string;
  name?: string;
}

function FormScreen({ onBack }: FormScreenProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const validate = (): boolean => {
    const newErrors: FormErrors = {};

    if (!name.trim()) {
      newErrors.name = 'Name is required';
    }

    if (!email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = 'Invalid email format';
    }

    if (!password) {
      newErrors.password = 'Password is required';
    } else if (password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setIsLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setIsLoading(false);
    setIsSubmitted(true);
  };

  const handleReset = () => {
    setName('');
    setEmail('');
    setPassword('');
    setErrors({});
    setIsSubmitted(false);
  };

  if (isSubmitted) {
    return (
      <View style={styles.screen} testID="form-screen">
        <View style={styles.successContainer} testID="success-container">
          <Text style={styles.successIcon}>✓</Text>
          <Text style={styles.successTitle} testID="success-title">
            Form Submitted!
          </Text>
          <Text style={styles.successMessage} testID="success-message">
            Welcome, {name}!
          </Text>
          <TouchableOpacity style={styles.button} testID="reset-btn" onPress={handleReset}>
            <Text style={styles.buttonText}>Start Over</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.backButton} testID="back-btn" onPress={onBack}>
            <Text style={styles.backButtonText}>← Back to Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} testID="form-screen">
      <TouchableOpacity style={styles.backButton} testID="back-btn" onPress={onBack}>
        <Text style={styles.backButtonText}>← Back to Home</Text>
      </TouchableOpacity>

      <Text style={styles.title} testID="form-title">
        Create Account
      </Text>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={[styles.input, errors.name && styles.inputError]}
          testID="name-input"
          placeholder="Enter your name"
          value={name}
          onChangeText={setName}
          editable={!isLoading}
        />
        {errors.name && (
          <Text style={styles.errorText} testID="name-error">
            {errors.name}
          </Text>
        )}
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          style={[styles.input, errors.email && styles.inputError]}
          testID="email-input"
          placeholder="Enter your email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          editable={!isLoading}
        />
        {errors.email && (
          <Text style={styles.errorText} testID="email-error">
            {errors.email}
          </Text>
        )}
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Password</Text>
        <TextInput
          style={[styles.input, errors.password && styles.inputError]}
          testID="password-input"
          placeholder="Enter your password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          editable={!isLoading}
        />
        {errors.password && (
          <Text style={styles.errorText} testID="password-error">
            {errors.password}
          </Text>
        )}
      </View>

      <TouchableOpacity
        style={[styles.button, isLoading && styles.buttonDisabled]}
        testID="submit-btn"
        onPress={handleSubmit}
        disabled={isLoading}
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" testID="loading-indicator" />
        ) : (
          <Text style={styles.buttonText}>Create Account</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.clearButton}
        testID="clear-btn"
        onPress={handleReset}
        disabled={isLoading}
      >
        <Text style={styles.clearButtonText}>Clear Form</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ============================================
// List Screen
// ============================================

interface ListScreenProps {
  onBack: () => void;
}

interface ListItem {
  id: string;
  title: string;
  subtitle: string;
  selected: boolean;
}

const generateItems = (count: number): ListItem[] => {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    title: `Item ${i + 1}`,
    subtitle: `This is the description for item ${i + 1}`,
    selected: false,
  }));
};

function ListScreen({ onBack }: ListScreenProps) {
  const [items, setItems] = useState<ListItem[]>(() => generateItems(100));
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);

  const handleRefresh = async () => {
    setRefreshing(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setItems(generateItems(100));
    setSelectedCount(0);
    setRefreshing(false);
  };

  const handleSelect = (itemId: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id === itemId) {
          const newSelected = !item.selected;
          setSelectedCount((count) => count + (newSelected ? 1 : -1));
          return { ...item, selected: newSelected };
        }
        return item;
      }),
    );
  };

  const handleClearSelection = () => {
    setItems((prev) => prev.map((item) => ({ ...item, selected: false })));
    setSelectedCount(0);
  };

  const renderItem = ({ item, index }: { item: ListItem; index: number }) => (
    <TouchableOpacity
      style={[styles.listItem, item.selected && styles.listItemSelected]}
      testID={`list-item-${index}`}
      onPress={() => handleSelect(item.id)}
    >
      <View style={styles.listItemContent}>
        <Text style={styles.listItemTitle} testID={`list-item-${index}-title`}>
          {item.title}
        </Text>
        <Text style={styles.listItemSubtitle} testID={`list-item-${index}-subtitle`}>
          {item.subtitle}
        </Text>
      </View>
      {item.selected && (
        <View style={styles.checkmark} testID={`list-item-${index}-check`}>
          <Text style={styles.checkmarkText}>✓</Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.screen} testID="list-screen">
      <TouchableOpacity style={styles.backButton} testID="back-btn" onPress={onBack}>
        <Text style={styles.backButtonText}>← Back to Home</Text>
      </TouchableOpacity>

      <View style={styles.listHeader}>
        <Text style={styles.listCount} testID="list-count">
          {items.length} items
        </Text>
        {selectedCount > 0 && (
          <>
            <Text style={styles.selectedCount} testID="selected-count">
              {selectedCount} selected
            </Text>
            <TouchableOpacity testID="clear-selection-btn" onPress={handleClearSelection}>
              <Text style={styles.clearText}>Clear</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <FlatList
        testID="item-list"
        data={items}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            testID="refresh-control"
          />
        }
      />
    </View>
  );
}

// ============================================
// Modal Screen
// ============================================

interface ModalScreenProps {
  onBack: () => void;
}

function ModalScreen({ onBack }: ModalScreenProps) {
  const [confirmModalVisible, setConfirmModalVisible] = useState(false);
  const [alertModalVisible, setAlertModalVisible] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  return (
    <View style={styles.screen} testID="modal-screen">
      <TouchableOpacity style={styles.backButton} testID="back-btn" onPress={onBack}>
        <Text style={styles.backButtonText}>← Back to Home</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Modal Demos</Text>

      {lastAction && (
        <View style={styles.lastActionContainer} testID="last-action-container">
          <Text style={styles.lastActionLabel}>Last Action:</Text>
          <Text style={styles.lastActionText} testID="last-action-text">
            {lastAction}
          </Text>
        </View>
      )}

      <View style={styles.buttons}>
        <TouchableOpacity
          style={styles.button}
          testID="open-confirm-modal-btn"
          onPress={() => setConfirmModalVisible(true)}
        >
          <Text style={styles.buttonText}>Confirmation Modal</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          testID="open-alert-modal-btn"
          onPress={() => setAlertModalVisible(true)}
        >
          <Text style={styles.buttonText}>Alert Modal</Text>
        </TouchableOpacity>
      </View>

      {/* Confirmation Modal */}
      <Modal visible={confirmModalVisible} transparent animationType="fade">
        <Pressable
          style={styles.overlay}
          testID="confirm-modal-overlay"
          onPress={() => {
            setConfirmModalVisible(false);
            setLastAction('Cancelled');
          }}
        >
          <Pressable
            style={styles.modalContent}
            testID="confirm-modal"
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle} testID="confirm-modal-title">
              Confirm Action
            </Text>
            <Text style={styles.modalMessage} testID="confirm-modal-message">
              Are you sure you want to proceed with this action?
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                testID="confirm-modal-cancel-btn"
                onPress={() => {
                  setConfirmModalVisible(false);
                  setLastAction('Cancelled');
                }}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.confirmButtonStyle]}
                testID="confirm-modal-confirm-btn"
                onPress={() => {
                  setConfirmModalVisible(false);
                  setLastAction('Confirmed!');
                }}
              >
                <Text style={styles.confirmButtonText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Alert Modal */}
      <Modal visible={alertModalVisible} transparent animationType="slide">
        <Pressable
          style={styles.overlay}
          testID="alert-modal-overlay"
          onPress={() => {
            setAlertModalVisible(false);
            setLastAction('Alert dismissed');
          }}
        >
          <Pressable
            style={styles.modalContent}
            testID="alert-modal"
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.alertIcon}>!</Text>
            <Text style={styles.modalTitle} testID="alert-modal-title">
              Important Notice
            </Text>
            <Text style={styles.modalMessage} testID="alert-modal-message">
              This is an important alert that requires your attention.
            </Text>
            <TouchableOpacity
              style={[styles.modalButton, styles.confirmButtonStyle, styles.fullWidthButton]}
              testID="alert-modal-dismiss-btn"
              onPress={() => {
                setAlertModalVisible(false);
                setLastAction('Alert dismissed');
              }}
            >
              <Text style={styles.confirmButtonText}>Understood</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ============================================
// Styles
// ============================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  screen: {
    flex: 1,
    padding: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#1e293b',
    textAlign: 'center',
    marginTop: 20,
  },
  subtitle: {
    fontSize: 18,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 40,
  },
  buttons: {
    gap: 12,
  },
  button: {
    backgroundColor: '#6366f1',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  backButton: {
    paddingVertical: 8,
  },
  backButtonText: {
    color: '#6366f1',
    fontSize: 16,
  },
  infoBox: {
    marginTop: 40,
    padding: 16,
    backgroundColor: '#e0e7ff',
    borderRadius: 12,
    borderCurve: 'continuous',
  },
  infoText: {
    fontSize: 14,
    color: '#3730a3',
    textAlign: 'center',
    lineHeight: 20,
  },
  inputContainer: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#1e293b',
    borderCurve: 'continuous',
  },
  inputError: {
    borderColor: '#ef4444',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 4,
  },
  clearButton: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  clearButtonText: {
    color: '#6366f1',
    fontSize: 16,
  },
  successContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  successIcon: {
    fontSize: 64,
    color: '#22c55e',
  },
  successTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1e293b',
    marginTop: 16,
  },
  successMessage: {
    fontSize: 18,
    color: '#64748b',
    marginTop: 8,
    marginBottom: 32,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  listCount: {
    fontSize: 14,
    color: '#64748b',
    flex: 1,
  },
  selectedCount: {
    fontSize: 14,
    color: '#6366f1',
    marginRight: 12,
  },
  clearText: {
    fontSize: 14,
    color: '#6366f1',
    fontWeight: '600',
  },
  listItem: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 8,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  listItemSelected: {
    backgroundColor: '#eef2ff',
  },
  listItemContent: {
    flex: 1,
  },
  listItemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
  },
  listItemSubtitle: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 2,
  },
  checkmark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#6366f1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkmarkText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  lastActionContainer: {
    backgroundColor: '#e0e7ff',
    padding: 16,
    borderRadius: 12,
    marginVertical: 16,
    borderCurve: 'continuous',
  },
  lastActionLabel: {
    fontSize: 12,
    color: '#6366f1',
    marginBottom: 4,
  },
  lastActionText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#3730a3',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 400,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 8,
    textAlign: 'center',
  },
  modalMessage: {
    fontSize: 16,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  cancelButton: {
    backgroundColor: '#f1f5f9',
  },
  cancelButtonText: {
    color: '#64748b',
    fontSize: 16,
    fontWeight: '600',
  },
  confirmButtonStyle: {
    backgroundColor: '#6366f1',
  },
  confirmButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  fullWidthButton: {
    width: '100%',
  },
  alertIcon: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#d97706',
    marginBottom: 16,
  },
});
