import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsState {
  notifications: {
    push: boolean;
    email: boolean;
    orderUpdates: boolean;
    promotions: boolean;
    newArrivals: boolean;
    priceDrops: boolean;
  };
  preferences: {
    darkMode: boolean;
    hapticFeedback: boolean;
    showBadges: boolean;
    language: string;
    currency: string;
  };
  privacy: {
    analytics: boolean;
    personalizedAds: boolean;
    locationServices: boolean;
  };
  updateNotification: <K extends keyof SettingsState['notifications']>(
    key: K,
    value: boolean,
  ) => void;
  updatePreference: <K extends keyof SettingsState['preferences']>(
    key: K,
    value: SettingsState['preferences'][K],
  ) => void;
  updatePrivacy: <K extends keyof SettingsState['privacy']>(key: K, value: boolean) => void;
  setLanguage: (language: string) => void;
  setCurrency: (currency: string) => void;
  resetSettings: () => void;
}

const defaultSettings = {
  notifications: {
    push: true,
    email: true,
    orderUpdates: true,
    promotions: false,
    newArrivals: true,
    priceDrops: true,
  },
  preferences: {
    darkMode: false,
    hapticFeedback: true,
    showBadges: true,
    language: 'English',
    currency: 'USD',
  },
  privacy: {
    analytics: true,
    personalizedAds: false,
    locationServices: false,
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,

      updateNotification: (key, value) =>
        set((state) => ({
          notifications: {
            ...state.notifications,
            [key]: value,
          },
        })),

      updatePreference: (key, value) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            [key]: value,
          },
        })),

      updatePrivacy: (key, value) =>
        set((state) => ({
          privacy: {
            ...state.privacy,
            [key]: value,
          },
        })),

      setLanguage: (language) =>
        set((state) => ({
          preferences: { ...state.preferences, language },
        })),

      setCurrency: (currency) =>
        set((state) => ({
          preferences: { ...state.preferences, currency },
        })),

      resetSettings: () => set(defaultSettings),
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

export const languages = ['English', 'Spanish', 'French', 'German', 'Japanese', 'Chinese'];
export const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CNY'];
