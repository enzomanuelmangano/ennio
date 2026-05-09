import type { ViewStyle } from 'react-native';
import { useSettingsStore } from '../store';

export type Theme = typeof lightTheme;

const lightShadows = {
  soft: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 3,
  } satisfies ViewStyle,
  depth: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.14,
    shadowRadius: 32,
    elevation: 12,
  } satisfies ViewStyle,
  inset: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  } satisfies ViewStyle,
};

const darkShadows = {
  soft: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 3,
  } satisfies ViewStyle,
  depth: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.7,
    shadowRadius: 36,
    elevation: 12,
  } satisfies ViewStyle,
  inset: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 1,
  } satisfies ViewStyle,
};

const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const lightTheme = {
  isDark: false as const,
  colors: {
    background: {
      primary: '#FAFAF7',
      elevated: '#FFFFFF',
      tonal: '#F4F1EC',
      sunken: '#F0EDE7',
    },
    surface: '#FFFFFF',
    text: {
      primary: '#0A0A0A',
      secondary: '#3D3D3A',
      muted: '#8A8780',
      onAccent: '#FAFAF7',
      onChampagne: '#0A0A0A',
    },
    accent: {
      ink: '#0A0A0A',
      inkPressed: '#1F1F1F',
      champagne: '#C3A875',
      champagneDeep: '#A88B57',
    },
    border: '#E8E4DC',
    divider: '#EFEBE2',
    overlay: 'rgba(10,10,10,0.45)',
    success: '#3F8F5E',
    warning: '#C39120',
    danger: '#B83A2E',
    star: '#C3A875',
  },
  shadows: lightShadows,
  radii,
  spacing,
};

export const darkTheme: Theme = {
  isDark: true,
  colors: {
    background: {
      primary: '#0A0A0A',
      elevated: '#161616',
      tonal: '#1F1D1A',
      sunken: '#050505',
    },
    surface: '#161616',
    text: {
      primary: '#FAFAF7',
      secondary: '#C8C5BD',
      muted: '#98948C',
      onAccent: '#0A0A0A',
      onChampagne: '#0A0A0A',
    },
    accent: {
      ink: '#FAFAF7',
      inkPressed: '#E8E4DC',
      champagne: '#C3A875',
      champagneDeep: '#A88B57',
    },
    border: '#2A2823',
    divider: '#1F1D1A',
    overlay: 'rgba(0,0,0,0.65)',
    success: '#5DB37C',
    warning: '#D4A437',
    danger: '#D55B4F',
    star: '#C3A875',
  },
  shadows: darkShadows,
  radii,
  spacing,
};

export function useTheme(): Theme {
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  return darkMode ? darkTheme : lightTheme;
}
