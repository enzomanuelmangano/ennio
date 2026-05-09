// Form validation — react-hook-form + zod. Tests Ennio against an
// inline error label that appears only when validation fails.

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';
import { useState } from 'react';

const schema = z.object({
  email: z.string().email('Invalid email'),
  age: z
    .string()
    .regex(/^\d+$/, 'Digits only')
    .refine((v) => Number(v) >= 18, 'Must be 18+'),
});
type FormValues = z.infer<typeof schema>;

export default function FormScreen() {
  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
  });
  const [submitted, setSubmitted] = useState<FormValues | null>(null);

  return (
    <View style={styles.container} testID="form-screen">
      <Text style={styles.title}>Form validation</Text>

      <Text style={styles.label}>Email</Text>
      <Controller
        control={control}
        name="email"
        render={({ field: { value, onChange } }) => (
          <TextInput
            testID="form-email"
            style={styles.input}
            value={value ?? ''}
            onChangeText={onChange}
            autoCapitalize="none"
            keyboardType="email-address"
          />
        )}
      />
      {errors.email && (
        <Text style={styles.error} testID="form-email-error">
          {errors.email.message}
        </Text>
      )}

      <Text style={styles.label}>Age</Text>
      <Controller
        control={control}
        name="age"
        render={({ field: { value, onChange } }) => (
          <TextInput
            testID="form-age"
            style={styles.input}
            value={value ?? ''}
            onChangeText={onChange}
            keyboardType="number-pad"
          />
        )}
      />
      {errors.age && (
        <Text style={styles.error} testID="form-age-error">
          {errors.age.message}
        </Text>
      )}

      <PressableScale
        testID="form-submit"
        style={styles.button}
        onPress={() => handleSubmit((v) => setSubmitted(v))()}
      >
        <Text style={styles.buttonText}>Submit</Text>
      </PressableScale>

      {submitted && (
        <Text style={styles.success} testID="form-submitted">
          Submitted: {submitted.email} / {submitted.age}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  label: { fontSize: 14, color: '#666', marginTop: 12, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    padding: 12,
    borderCurve: 'continuous',
  },
  error: { color: '#FF3B30', marginTop: 4, fontSize: 12 },
  button: {
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 24,
    borderCurve: 'continuous',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  success: { marginTop: 16, color: '#34C759' },
});
