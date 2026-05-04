import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter, Stack } from 'expo-router';
import { useCartStore, useSettingsStore } from '../store';
import * as Haptics from 'expo-haptics';

type Step = 'shipping' | 'payment' | 'review';

export default function CheckoutScreen() {
  const router = useRouter();
  const items = useCartStore(state => state.items);
  const getTotal = useCartStore(state => state.getTotal);
  const getSubtotal = useCartStore(state => state.getSubtotal);
  const getTax = useCartStore(state => state.getTax);
  const checkout = useCartStore(state => state.checkout);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  const [currentStep, setCurrentStep] = useState<Step>('shipping');
  const [isProcessing, setIsProcessing] = useState(false);

  const [shippingAddress, setShippingAddress] = useState({
    fullName: '',
    street: '',
    city: '',
    state: '',
    zipCode: '',
    phone: '',
  });

  const [paymentMethod, setPaymentMethod] = useState({
    cardNumber: '',
    expiryDate: '',
    cvv: '',
    cardholderName: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateShipping = () => {
    const newErrors: Record<string, string> = {};
    if (!shippingAddress.fullName.trim()) newErrors.fullName = 'Name is required';
    if (!shippingAddress.street.trim()) newErrors.street = 'Street address is required';
    if (!shippingAddress.city.trim()) newErrors.city = 'City is required';
    if (!shippingAddress.state.trim()) newErrors.state = 'State is required';
    if (!shippingAddress.zipCode.trim()) newErrors.zipCode = 'ZIP code is required';
    if (!shippingAddress.phone.trim()) newErrors.phone = 'Phone is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validatePayment = () => {
    const newErrors: Record<string, string> = {};
    if (!paymentMethod.cardNumber.replace(/\s/g, '').match(/^\d{16}$/)) {
      newErrors.cardNumber = 'Invalid card number';
    }
    if (!paymentMethod.expiryDate.match(/^\d{2}\/\d{2}$/)) {
      newErrors.expiryDate = 'Invalid expiry (MM/YY)';
    }
    if (!paymentMethod.cvv.match(/^\d{3,4}$/)) {
      newErrors.cvv = 'Invalid CVV';
    }
    if (!paymentMethod.cardholderName.trim()) {
      newErrors.cardholderName = 'Cardholder name is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (currentStep === 'shipping') {
      if (validateShipping()) {
        setCurrentStep('payment');
        if (hapticEnabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    } else if (currentStep === 'payment') {
      if (validatePayment()) {
        setCurrentStep('review');
        if (hapticEnabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    }
  };

  const handleBack = () => {
    if (currentStep === 'payment') setCurrentStep('shipping');
    else if (currentStep === 'review') setCurrentStep('payment');
  };

  const handlePlaceOrder = async () => {
    setIsProcessing(true);
    try {
      const address = `${shippingAddress.street}, ${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.zipCode}`;
      await checkout(address);
      if (hapticEnabled) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      Alert.alert(
        'Order Placed!',
        'Your order has been placed successfully. You will receive a confirmation email shortly.',
        [{ text: 'View Orders', onPress: () => router.replace('/orders') }]
      );
    } catch (error) {
      Alert.alert('Error', 'Failed to place order. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const formatCardNumber = (text: string) => {
    const cleaned = text.replace(/\D/g, '').slice(0, 16);
    return cleaned.replace(/(.{4})/g, '$1 ').trim();
  };

  const formatExpiryDate = (text: string) => {
    const cleaned = text.replace(/\D/g, '').slice(0, 4);
    if (cleaned.length > 2) {
      return `${cleaned.slice(0, 2)}/${cleaned.slice(2)}`;
    }
    return cleaned;
  };

  const renderStepIndicator = () => (
    <View style={styles.stepIndicator}>
      {(['shipping', 'payment', 'review'] as Step[]).map((step, index) => (
        <View key={step} style={styles.stepItem}>
          <View
            style={[
              styles.stepCircle,
              currentStep === step && styles.stepCircleActive,
              (['shipping', 'payment', 'review'].indexOf(currentStep) > index) && styles.stepCircleCompleted,
            ]}
          >
            <Text style={styles.stepNumber}>
              {(['shipping', 'payment', 'review'].indexOf(currentStep) > index) ? '✓' : index + 1}
            </Text>
          </View>
          <Text style={[
            styles.stepLabel,
            darkMode && styles.subtitleDark,
            currentStep === step && styles.stepLabelActive,
          ]}>
            {step.charAt(0).toUpperCase() + step.slice(1)}
          </Text>
          {index < 2 && <View style={[styles.stepLine, darkMode && styles.stepLineDark]} />}
        </View>
      ))}
    </View>
  );

  const renderShippingForm = () => (
    <View testID="shipping-form">
      <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Shipping Address</Text>

      <View style={styles.inputGroup}>
        <Text style={[styles.label, darkMode && styles.textLight]}>Full Name</Text>
        <TextInput
          style={[styles.input, darkMode && styles.inputDark, errors.fullName && styles.inputError]}
          defaultValue={shippingAddress.fullName}
          onChangeText={text => setShippingAddress(prev => ({ ...prev, fullName: text }))}
          placeholder="John Doe"
          placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          testID="shipping-name"
        />
        {errors.fullName && <Text style={styles.errorText}>{errors.fullName}</Text>}
      </View>

      <View style={styles.inputGroup}>
        <Text style={[styles.label, darkMode && styles.textLight]}>Street Address</Text>
        <TextInput
          style={[styles.input, darkMode && styles.inputDark, errors.street && styles.inputError]}
          defaultValue={shippingAddress.street}
          onChangeText={text => setShippingAddress(prev => ({ ...prev, street: text }))}
          placeholder="123 Main St"
          placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          testID="shipping-street"
        />
        {errors.street && <Text style={styles.errorText}>{errors.street}</Text>}
      </View>

      <View style={styles.row}>
        <View style={[styles.inputGroup, styles.flex1, styles.marginRight]}>
          <Text style={[styles.label, darkMode && styles.textLight]}>City</Text>
          <TextInput
            style={[styles.input, darkMode && styles.inputDark, errors.city && styles.inputError]}
            defaultValue={shippingAddress.city}
            onChangeText={text => setShippingAddress(prev => ({ ...prev, city: text }))}
            placeholder="New York"
            placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
            testID="shipping-city"
          />
          {errors.city && <Text style={styles.errorText}>{errors.city}</Text>}
        </View>
        <View style={[styles.inputGroup, styles.flex1]}>
          <Text style={[styles.label, darkMode && styles.textLight]}>State</Text>
          <TextInput
            style={[styles.input, darkMode && styles.inputDark, errors.state && styles.inputError]}
            defaultValue={shippingAddress.state}
            onChangeText={text => setShippingAddress(prev => ({ ...prev, state: text }))}
            placeholder="NY"
            placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
            testID="shipping-state"
          />
          {errors.state && <Text style={styles.errorText}>{errors.state}</Text>}
        </View>
      </View>

      <View style={styles.row}>
        <View style={[styles.inputGroup, styles.flex1, styles.marginRight]}>
          <Text style={[styles.label, darkMode && styles.textLight]}>ZIP Code</Text>
          <TextInput
            style={[styles.input, darkMode && styles.inputDark, errors.zipCode && styles.inputError]}
            defaultValue={shippingAddress.zipCode}
            onChangeText={text => setShippingAddress(prev => ({ ...prev, zipCode: text }))}
            placeholder="10001"
            placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
            keyboardType="numeric"
            testID="shipping-zip"
          />
          {errors.zipCode && <Text style={styles.errorText}>{errors.zipCode}</Text>}
        </View>
        <View style={[styles.inputGroup, styles.flex1]}>
          <Text style={[styles.label, darkMode && styles.textLight]}>Phone</Text>
          <TextInput
            style={[styles.input, darkMode && styles.inputDark, errors.phone && styles.inputError]}
            defaultValue={shippingAddress.phone}
            onChangeText={text => setShippingAddress(prev => ({ ...prev, phone: text }))}
            placeholder="(555) 123-4567"
            placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
            testID="shipping-phone"
          />
          {errors.phone && <Text style={styles.errorText}>{errors.phone}</Text>}
        </View>
      </View>
    </View>
  );

  const renderPaymentForm = () => (
    <View testID="payment-form">
      <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Payment Details</Text>

      <View style={styles.inputGroup}>
        <Text style={[styles.label, darkMode && styles.textLight]}>Card Number</Text>
        <TextInput
          style={[styles.input, darkMode && styles.inputDark, errors.cardNumber && styles.inputError]}
          defaultValue={paymentMethod.cardNumber}
          onChangeText={text => setPaymentMethod(prev => ({ ...prev, cardNumber: formatCardNumber(text) }))}
          placeholder="1234 5678 9012 3456"
          placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          keyboardType="numeric"
          testID="payment-card-number"
        />
        {errors.cardNumber && <Text style={styles.errorText}>{errors.cardNumber}</Text>}
      </View>

      <View style={styles.inputGroup}>
        <Text style={[styles.label, darkMode && styles.textLight]}>Cardholder Name</Text>
        <TextInput
          style={[styles.input, darkMode && styles.inputDark, errors.cardholderName && styles.inputError]}
          defaultValue={paymentMethod.cardholderName}
          onChangeText={text => setPaymentMethod(prev => ({ ...prev, cardholderName: text }))}
          placeholder="JOHN DOE"
          placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="characters"
          spellCheck={false}
          testID="payment-cardholder"
        />
        {errors.cardholderName && <Text style={styles.errorText}>{errors.cardholderName}</Text>}
      </View>

      <View style={styles.row}>
        <View style={[styles.inputGroup, styles.flex1, styles.marginRight]}>
          <Text style={[styles.label, darkMode && styles.textLight]}>Expiry Date</Text>
          <TextInput
            style={[styles.input, darkMode && styles.inputDark, errors.expiryDate && styles.inputError]}
            defaultValue={paymentMethod.expiryDate}
            onChangeText={text => setPaymentMethod(prev => ({ ...prev, expiryDate: formatExpiryDate(text) }))}
            placeholder="MM/YY"
            placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
            keyboardType="numeric"
            testID="payment-expiry"
          />
          {errors.expiryDate && <Text style={styles.errorText}>{errors.expiryDate}</Text>}
        </View>
        <View style={[styles.inputGroup, styles.flex1]}>
          <Text style={[styles.label, darkMode && styles.textLight]}>CVV</Text>
          <TextInput
            style={[styles.input, darkMode && styles.inputDark, errors.cvv && styles.inputError]}
            defaultValue={paymentMethod.cvv}
            onChangeText={text => setPaymentMethod(prev => ({ ...prev, cvv: text.replace(/\D/g, '').slice(0, 4) }))}
            placeholder="123"
            placeholderTextColor={darkMode ? '#666' : '#999'}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
            keyboardType="numeric"
            secureTextEntry
            testID="payment-cvv"
          />
          {errors.cvv && <Text style={styles.errorText}>{errors.cvv}</Text>}
        </View>
      </View>

      <View style={[styles.securityNote, darkMode && styles.cardDark]}>
        <Text style={styles.securityIcon}>🔒</Text>
        <Text style={[styles.securityText, darkMode && styles.subtitleDark]}>
          Your payment information is encrypted and secure
        </Text>
      </View>
    </View>
  );

  const renderReview = () => (
    <View testID="order-review">
      <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Order Review</Text>

      <View style={[styles.reviewCard, darkMode && styles.cardDark]}>
        <Text style={[styles.reviewLabel, darkMode && styles.subtitleDark]}>Shipping To:</Text>
        <Text style={[styles.reviewValue, darkMode && styles.textLight]}>{shippingAddress.fullName}</Text>
        <Text style={[styles.reviewSubvalue, darkMode && styles.subtitleDark]}>
          {shippingAddress.street}, {shippingAddress.city}, {shippingAddress.state} {shippingAddress.zipCode}
        </Text>
        <Text style={[styles.reviewSubvalue, darkMode && styles.subtitleDark]}>{shippingAddress.phone}</Text>
      </View>

      <View style={[styles.reviewCard, darkMode && styles.cardDark]}>
        <Text style={[styles.reviewLabel, darkMode && styles.subtitleDark]}>Payment Method:</Text>
        <Text style={[styles.reviewValue, darkMode && styles.textLight]}>
          •••• •••• •••• {paymentMethod.cardNumber.slice(-4)}
        </Text>
        <Text style={[styles.reviewSubvalue, darkMode && styles.subtitleDark]}>
          {paymentMethod.cardholderName}
        </Text>
      </View>

      <View style={[styles.reviewCard, darkMode && styles.cardDark]}>
        <Text style={[styles.reviewLabel, darkMode && styles.subtitleDark]}>Items ({items.length}):</Text>
        {items.map(item => (
          <View key={item.product.id} style={styles.reviewItem}>
            <Text style={[styles.reviewItemName, darkMode && styles.textLight]}>
              {item.quantity}x {item.product.name}
            </Text>
            <Text style={styles.reviewItemPrice}>${(item.product.price * item.quantity).toFixed(2)}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.totalCard, darkMode && styles.cardDark]}>
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, darkMode && styles.subtitleDark]}>Subtotal</Text>
          <Text style={[styles.totalValue, darkMode && styles.textLight]}>${getSubtotal().toFixed(2)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, darkMode && styles.subtitleDark]}>Tax (10%)</Text>
          <Text style={[styles.totalValue, darkMode && styles.textLight]}>${getTax().toFixed(2)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, darkMode && styles.subtitleDark]}>Shipping</Text>
          <Text style={styles.freeShipping}>FREE</Text>
        </View>
        <View style={[styles.totalRow, styles.grandTotal]}>
          <Text style={[styles.grandTotalLabel, darkMode && styles.textLight]}>Total</Text>
          <Text style={styles.grandTotalValue}>${getTotal().toFixed(2)}</Text>
        </View>
      </View>
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Checkout',
          headerStyle: { backgroundColor: darkMode ? '#1a1a2e' : '#ffffff' },
          headerTintColor: darkMode ? '#ffffff' : '#000000',
        }}
      />
      <KeyboardAvoidingView
        style={[styles.container, darkMode && styles.containerDark]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={styles.flex1} testID="checkout-screen">
        {renderStepIndicator()}

        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentContainer}
          keyboardShouldPersistTaps="handled"
        >
          {currentStep === 'shipping' && renderShippingForm()}
          {currentStep === 'payment' && renderPaymentForm()}
          {currentStep === 'review' && renderReview()}
        </ScrollView>

        <View style={[styles.footer, darkMode && styles.footerDark]}>
          {currentStep !== 'shipping' && (
            <PressableScale
              style={[styles.backButton, darkMode && styles.backButtonDark]}
              onPress={handleBack}
              testID="back-btn"
            >
              <Text style={[styles.backButtonText, darkMode && styles.textLight]}>Back</Text>
            </PressableScale>
          )}
          <PressableScale
            style={[
              styles.nextButton,
              currentStep === 'shipping' && styles.nextButtonFull,
              isProcessing && styles.nextButtonDisabled,
            ]}
            onPress={currentStep === 'review' ? handlePlaceOrder : handleNext}
            enabled={!isProcessing}
            testID={currentStep === 'review' ? 'place-order-btn' : 'next-btn'}
          >
            {isProcessing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.nextButtonText}>
                {currentStep === 'review' ? 'Place Order' : 'Continue'}
              </Text>
            )}
          </PressableScale>
        </View>
        </View>
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
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    paddingTop: 10,
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e0e0e0',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  stepCircleActive: {
    backgroundColor: '#007AFF',
  },
  stepCircleCompleted: {
    backgroundColor: '#34C759',
  },
  stepNumber: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 12,
  },
  stepLabel: {
    fontSize: 12,
    color: '#666',
  },
  stepLabelActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  stepLine: {
    width: 30,
    height: 2,
    backgroundColor: '#e0e0e0',
    marginHorizontal: 8,
  },
  stepLineDark: {
    backgroundColor: '#2a2a3e',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 380,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 20,
  },
  textLight: {
    color: '#fff',
  },
  subtitleDark: {
    color: '#aaa',
  },
  cardDark: {
    backgroundColor: '#1a1a2e',
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
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
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
  },
  flex1: {
    flex: 1,
  },
  marginRight: {
    marginRight: 12,
  },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    marginTop: 8,
  },
  securityIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  securityText: {
    fontSize: 13,
    color: '#666',
    flex: 1,
  },
  reviewCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  reviewLabel: {
    fontSize: 12,
    color: '#666',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  reviewValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  reviewSubvalue: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  reviewItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  reviewItemName: {
    fontSize: 14,
    color: '#1a1a2e',
    flex: 1,
  },
  reviewItemPrice: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  totalCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  totalLabel: {
    fontSize: 14,
    color: '#666',
  },
  totalValue: {
    fontSize: 14,
    color: '#1a1a2e',
  },
  freeShipping: {
    fontSize: 14,
    color: '#34C759',
    fontWeight: '600',
  },
  grandTotal: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 12,
    marginTop: 5,
    marginBottom: 0,
  },
  grandTotalLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  grandTotalValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  footer: {
    flexDirection: 'row',
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  footerDark: {
    backgroundColor: '#1a1a2e',
    borderTopColor: '#2a2a3e',
  },
  backButton: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    marginRight: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  backButtonDark: {
    borderColor: '#2a2a3e',
  },
  backButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  nextButton: {
    flex: 2,
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 10,
  },
  nextButtonFull: {
    flex: 1,
  },
  nextButtonDisabled: {
    backgroundColor: '#99c9ff',
  },
  nextButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
