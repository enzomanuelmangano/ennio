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
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter, Stack } from 'expo-router';
import { useCartStore, useSettingsStore } from '../store';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, lineHeight, radius } from '../src/theme';

type Palette = ReturnType<typeof colors>;
type Step = 'shipping' | 'payment' | 'review';

export default function CheckoutScreen() {
  const router = useRouter();
  const items = useCartStore(state => state.items);
  const getTotal = useCartStore(state => state.getTotal);
  const getSubtotal = useCartStore(state => state.getSubtotal);
  const getTax = useCartStore(state => state.getTax);
  const checkout = useCartStore(state => state.checkout);
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);

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
    if (!shippingAddress.fullName.trim())
      newErrors.fullName = 'Name is required';
    if (!shippingAddress.street.trim())
      newErrors.street = 'Street address is required';
    if (!shippingAddress.city.trim()) newErrors.city = 'City is required';
    if (!shippingAddress.state.trim()) newErrors.state = 'State is required';
    if (!shippingAddress.zipCode.trim())
      newErrors.zipCode = 'ZIP code is required';
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
        if (hapticEnabled)
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    } else if (currentStep === 'payment') {
      if (validatePayment()) {
        setCurrentStep('review');
        if (hapticEnabled)
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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
        [{ text: 'View Orders', onPress: () => router.replace('/orders') }],
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
    <View
      style={[
        styles.stepIndicator,
        { backgroundColor: c.systemGroupedBackground },
      ]}
    >
      {(['shipping', 'payment', 'review'] as Step[]).map((step, index) => {
        const isCompleted =
          ['shipping', 'payment', 'review'].indexOf(currentStep) > index;
        const isActive = currentStep === step;
        const tint = isCompleted
          ? c.systemGreen
          : isActive
            ? c.systemBlue
            : c.tertiarySystemFill;
        return (
          <View key={step} style={styles.stepItem}>
            <View
              style={[
                styles.stepCircle,
                {
                  backgroundColor: tint,
                },
              ]}
            >
              <Text
                style={[
                  styles.stepNumber,
                  {
                    color:
                      isActive || isCompleted ? '#FFFFFF' : c.secondaryLabel,
                  },
                ]}
              >
                {isCompleted ? '✓' : index + 1}
              </Text>
            </View>
            <Text
              style={[
                styles.stepLabel,
                {
                  color: isActive
                    ? c.label
                    : isCompleted
                      ? c.secondaryLabel
                      : c.tertiaryLabel,
                  fontWeight: isActive ? '600' : '500',
                },
              ]}
            >
              {step.charAt(0).toUpperCase() + step.slice(1)}
            </Text>
            {index < 2 && (
              <View
                style={[styles.stepLine, { backgroundColor: c.separator }]}
              />
            )}
          </View>
        );
      })}
    </View>
  );

  const fieldRow = (
    key: string,
    label: string,
    placeholder: string,
    value: string,
    onChange: (v: string) => void,
    extraProps: Partial<React.ComponentProps<typeof TextInput>> = {},
  ) => (
    <View style={styles.fieldRow}>
      <Text style={[styles.fieldLabel, { color: c.secondaryLabel }]}>
        {label}
      </Text>
      <TextInput
        style={[styles.fieldInput, { color: c.label }]}
        defaultValue={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.tertiaryLabel}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        {...extraProps}
      />
    </View>
  );

  const renderShippingForm = () => (
    <View testID="shipping-form">
      <Text style={[styles.sectionTitle, { color: c.label }]}>
        Shipping Address
      </Text>
      <View
        style={[
          styles.card,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        {fieldRow(
          'fullName',
          'Name',
          'John Doe',
          shippingAddress.fullName,
          text => setShippingAddress(p => ({ ...p, fullName: text })),
          { testID: 'shipping-name' as any },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'street',
          'Street',
          '123 Main St',
          shippingAddress.street,
          text => setShippingAddress(p => ({ ...p, street: text })),
          { testID: 'shipping-street' as any },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'city',
          'City',
          'New York',
          shippingAddress.city,
          text => setShippingAddress(p => ({ ...p, city: text })),
          { testID: 'shipping-city' as any },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'state',
          'State',
          'NY',
          shippingAddress.state,
          text => setShippingAddress(p => ({ ...p, state: text })),
          { testID: 'shipping-state' as any },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'zipCode',
          'ZIP',
          '10001',
          shippingAddress.zipCode,
          text => setShippingAddress(p => ({ ...p, zipCode: text })),
          { keyboardType: 'numeric', testID: 'shipping-zip' as any },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'phone',
          'Phone',
          '(555) 123-4567',
          shippingAddress.phone,
          text => setShippingAddress(p => ({ ...p, phone: text })),
          { testID: 'shipping-phone' as any },
        )}
      </View>
      {Object.values(errors).filter(Boolean).length > 0 && (
        <View style={styles.errorBlock}>
          {Object.entries(errors).map(([key, msg]) => (
            <Text
              key={key}
              style={[styles.errorText, { color: c.systemRed }]}
            >
              {msg}
            </Text>
          ))}
        </View>
      )}
    </View>
  );

  const renderPaymentForm = () => (
    <View testID="payment-form">
      <Text style={[styles.sectionTitle, { color: c.label }]}>
        Payment Details
      </Text>
      <View
        style={[
          styles.card,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        {fieldRow(
          'cardNumber',
          'Card',
          '1234 5678 9012 3456',
          paymentMethod.cardNumber,
          text =>
            setPaymentMethod(p => ({
              ...p,
              cardNumber: formatCardNumber(text),
            })),
          {
            keyboardType: 'numeric',
            testID: 'payment-card-number' as any,
          },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'cardholderName',
          'Holder',
          'JOHN DOE',
          paymentMethod.cardholderName,
          text => setPaymentMethod(p => ({ ...p, cardholderName: text })),
          {
            autoCapitalize: 'characters',
            testID: 'payment-cardholder' as any,
          },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'expiryDate',
          'Expiry',
          'MM/YY',
          paymentMethod.expiryDate,
          text =>
            setPaymentMethod(p => ({
              ...p,
              expiryDate: formatExpiryDate(text),
            })),
          { keyboardType: 'numeric', testID: 'payment-expiry' as any },
        )}
        <View style={[styles.divider, { backgroundColor: c.separator }]} />
        {fieldRow(
          'cvv',
          'CVV',
          '123',
          paymentMethod.cvv,
          text =>
            setPaymentMethod(p => ({
              ...p,
              cvv: text.replace(/\D/g, '').slice(0, 4),
            })),
          {
            keyboardType: 'numeric',
            secureTextEntry: true,
            testID: 'payment-cvv' as any,
          },
        )}
      </View>

      <View
        style={[
          styles.securityNote,
          { backgroundColor: c.systemGreen + '15' },
        ]}
      >
        <Text style={[styles.securityIcon, { color: c.systemGreen }]}>⚿</Text>
        <Text style={[styles.securityText, { color: c.label }]}>
          Your payment information is encrypted and secure
        </Text>
      </View>

      {Object.values(errors).filter(Boolean).length > 0 && (
        <View style={styles.errorBlock}>
          {Object.entries(errors).map(([key, msg]) => (
            <Text
              key={key}
              style={[styles.errorText, { color: c.systemRed }]}
            >
              {msg}
            </Text>
          ))}
        </View>
      )}
    </View>
  );

  const renderReview = () => (
    <View testID="order-review">
      <Text style={[styles.sectionTitle, { color: c.label }]}>
        Order Review
      </Text>

      <Text style={[styles.cardLabel, { color: c.secondaryLabel }]}>
        SHIPPING TO
      </Text>
      <View
        style={[
          styles.reviewCard,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        <Text style={[styles.reviewValue, { color: c.label }]}>
          {shippingAddress.fullName}
        </Text>
        <Text style={[styles.reviewSubvalue, { color: c.secondaryLabel }]}>
          {shippingAddress.street}, {shippingAddress.city},{' '}
          {shippingAddress.state} {shippingAddress.zipCode}
        </Text>
        <Text style={[styles.reviewSubvalue, { color: c.secondaryLabel }]}>
          {shippingAddress.phone}
        </Text>
      </View>

      <Text style={[styles.cardLabel, { color: c.secondaryLabel }]}>
        PAYMENT METHOD
      </Text>
      <View
        style={[
          styles.reviewCard,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        <Text style={[styles.reviewValue, { color: c.label }]}>
          •••• •••• •••• {paymentMethod.cardNumber.slice(-4)}
        </Text>
        <Text style={[styles.reviewSubvalue, { color: c.secondaryLabel }]}>
          {paymentMethod.cardholderName}
        </Text>
      </View>

      <Text style={[styles.cardLabel, { color: c.secondaryLabel }]}>
        ITEMS ({items.length})
      </Text>
      <View
        style={[
          styles.reviewCard,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        {items.map((item, idx) => (
          <View
            key={item.product.id}
            style={[
              styles.reviewItem,
              idx < items.length - 1 && {
                borderBottomColor: c.separator,
                borderBottomWidth: StyleSheet.hairlineWidth,
              },
            ]}
          >
            <Text
              style={[styles.reviewItemName, { color: c.label }]}
              numberOfLines={2}
            >
              {item.quantity}× {item.product.name}
            </Text>
            <Text style={[styles.reviewItemPrice, { color: c.label }]}>
              ${(item.product.price * item.quantity).toFixed(2)}
            </Text>
          </View>
        ))}
      </View>

      <View
        style={[
          styles.totalCard,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, { color: c.secondaryLabel }]}>
            Subtotal
          </Text>
          <Text style={[styles.totalValue, { color: c.label }]}>
            ${getSubtotal().toFixed(2)}
          </Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, { color: c.secondaryLabel }]}>
            Tax (10%)
          </Text>
          <Text style={[styles.totalValue, { color: c.label }]}>
            ${getTax().toFixed(2)}
          </Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, { color: c.secondaryLabel }]}>
            Shipping
          </Text>
          <Text style={[styles.freeShipping, { color: c.systemGreen }]}>
            FREE
          </Text>
        </View>
        <View
          style={[
            styles.grandTotal,
            { borderTopColor: c.separator },
          ]}
        >
          <Text style={[styles.grandTotalLabel, { color: c.label }]}>
            Total
          </Text>
          <Text style={[styles.grandTotalValue, { color: c.label }]}>
            ${getTotal().toFixed(2)}
          </Text>
        </View>
      </View>
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Checkout',
          headerStyle: { backgroundColor: c.systemBackground },
          headerTintColor: c.label,
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: c.systemGroupedBackground }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={{ flex: 1 }} testID="checkout-screen">
          {renderStepIndicator()}

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.contentContainer}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {currentStep === 'shipping' && renderShippingForm()}
            {currentStep === 'payment' && renderPaymentForm()}
            {currentStep === 'review' && renderReview()}
          </ScrollView>

          <View
            style={[
              styles.footer,
              {
                backgroundColor: c.secondarySystemGroupedBackground,
                borderTopColor: c.separator,
              },
            ]}
          >
            {currentStep !== 'shipping' && (
              <PressableScale
                style={[
                  styles.backButton,
                  { backgroundColor: c.tertiarySystemFill },
                ]}
                onPress={handleBack}
                testID="back-btn"
              >
                <Text style={[styles.backButtonText, { color: c.label }]}>
                  Back
                </Text>
              </PressableScale>
            )}
            <PressableScale
              style={StyleSheet.flatten([
                styles.nextButton,
                { backgroundColor: c.systemBlue },
                currentStep === 'shipping' && styles.nextButtonFull,
                isProcessing && { opacity: 0.6 },
              ])}
              onPress={
                currentStep === 'review' ? handlePlaceOrder : handleNext
              }
              enabled={!isProcessing}
              testID={currentStep === 'review' ? 'place-order-btn' : 'next-btn'}
            >
              {isProcessing ? (
                <ActivityIndicator color="#FFFFFF" />
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
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  stepNumber: {
    fontWeight: '700',
    fontSize: fontSize.caption1,
  },
  stepLabel: {
    fontSize: fontSize.subhead,
  },
  stepLine: {
    width: 28,
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  sectionTitle: {
    fontSize: fontSize.title2,
    lineHeight: lineHeight.title2,
    fontWeight: '700',
    marginBottom: 14,
    marginHorizontal: 4,
  },
  card: {
    borderRadius: radius.card,
    paddingVertical: 4,
    marginBottom: 14,
  },
  cardLabel: {
    fontSize: fontSize.footnote,
    fontWeight: '400',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 8,
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
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 14,
  },
  errorBlock: {
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  errorText: {
    fontSize: fontSize.caption1,
    marginBottom: 2,
  },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: radius.card,
    marginBottom: 8,
  },
  securityIcon: {
    fontSize: 16,
    fontWeight: '700',
    marginRight: 8,
  },
  securityText: {
    fontSize: fontSize.footnote,
    flex: 1,
  },
  reviewCard: {
    borderRadius: radius.card,
    padding: 14,
  },
  reviewValue: {
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  reviewSubvalue: {
    fontSize: fontSize.subhead,
    marginTop: 2,
  },
  reviewItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  reviewItemName: {
    fontSize: fontSize.subhead,
    flex: 1,
    marginRight: 8,
  },
  reviewItemPrice: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  totalCard: {
    borderRadius: radius.card,
    padding: 14,
    marginTop: 14,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  totalLabel: {
    fontSize: fontSize.subhead,
  },
  totalValue: {
    fontSize: fontSize.subhead,
    fontWeight: '500',
  },
  freeShipping: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  grandTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    marginTop: 4,
  },
  grandTotalLabel: {
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  grandTotalValue: {
    fontSize: fontSize.title3,
    fontWeight: '700',
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  backButton: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: radius.button,
  },
  backButtonText: {
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  nextButton: {
    flex: 2,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: radius.button,
  },
  nextButtonFull: {
    flex: 1,
  },
  nextButtonText: {
    color: '#FFFFFF',
    fontSize: fontSize.body,
    fontWeight: '600',
  },
});
