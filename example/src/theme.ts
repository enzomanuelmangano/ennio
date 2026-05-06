/**
 * iOS system colors (UIColor) approximated for light & dark scheme.
 *
 * Single source of truth so every screen pulls the same vocabulary.
 * Picked to match Apple's published values for `UIColor.systemBlue`,
 * `secondaryLabel`, `systemGroupedBackground`, etc.
 */

export type Scheme = 'light' | 'dark';

type Palette = {
  // text
  label: string;
  secondaryLabel: string;
  tertiaryLabel: string;
  quaternaryLabel: string;
  // backgrounds
  systemBackground: string;
  secondarySystemBackground: string;
  systemGroupedBackground: string;
  secondarySystemGroupedBackground: string;
  // structure
  separator: string;
  opaqueSeparator: string;
  // tints
  systemBlue: string;
  systemGreen: string;
  systemRed: string;
  systemOrange: string;
  systemYellow: string;
  systemPurple: string;
  systemPink: string;
  systemTeal: string;
  systemIndigo: string;
  // fills
  systemFill: string;
  secondarySystemFill: string;
  tertiarySystemFill: string;
};

const light: Palette = {
  label: '#000000',
  secondaryLabel: 'rgba(60, 60, 67, 0.6)',
  tertiaryLabel: 'rgba(60, 60, 67, 0.3)',
  quaternaryLabel: 'rgba(60, 60, 67, 0.18)',
  systemBackground: '#FFFFFF',
  secondarySystemBackground: '#F2F2F7',
  systemGroupedBackground: '#F2F2F7',
  secondarySystemGroupedBackground: '#FFFFFF',
  separator: 'rgba(60, 60, 67, 0.29)',
  opaqueSeparator: '#C6C6C8',
  systemBlue: '#007AFF',
  systemGreen: '#34C759',
  systemRed: '#FF3B30',
  systemOrange: '#FF9500',
  systemYellow: '#FFCC00',
  systemPurple: '#AF52DE',
  systemPink: '#FF2D55',
  systemTeal: '#30B0C7',
  systemIndigo: '#5856D6',
  systemFill: 'rgba(120, 120, 128, 0.2)',
  secondarySystemFill: 'rgba(120, 120, 128, 0.16)',
  tertiarySystemFill: 'rgba(118, 118, 128, 0.12)',
};

const dark: Palette = {
  label: '#FFFFFF',
  secondaryLabel: 'rgba(235, 235, 245, 0.6)',
  tertiaryLabel: 'rgba(235, 235, 245, 0.3)',
  quaternaryLabel: 'rgba(235, 235, 245, 0.18)',
  systemBackground: '#000000',
  secondarySystemBackground: '#1C1C1E',
  systemGroupedBackground: '#000000',
  secondarySystemGroupedBackground: '#1C1C1E',
  separator: 'rgba(84, 84, 88, 0.65)',
  opaqueSeparator: '#38383A',
  systemBlue: '#0A84FF',
  systemGreen: '#30D158',
  systemRed: '#FF453A',
  systemOrange: '#FF9F0A',
  systemYellow: '#FFD60A',
  systemPurple: '#BF5AF2',
  systemPink: '#FF375F',
  systemTeal: '#40C8E0',
  systemIndigo: '#5E5CE6',
  systemFill: 'rgba(120, 120, 128, 0.36)',
  secondarySystemFill: 'rgba(120, 120, 128, 0.32)',
  tertiarySystemFill: 'rgba(118, 118, 128, 0.24)',
};

export function colors(scheme: Scheme): Palette {
  return scheme === 'dark' ? dark : light;
}

/**
 * iOS Dynamic Type (Large) point sizes.
 */
export const fontSize = {
  largeTitle: 34,
  title1: 28,
  title2: 22,
  title3: 20,
  headline: 17,
  body: 17,
  callout: 16,
  subhead: 15,
  footnote: 13,
  caption1: 12,
  caption2: 11,
} as const;

/**
 * iOS line heights aligned with Dynamic Type.
 */
export const lineHeight = {
  largeTitle: 41,
  title1: 34,
  title2: 28,
  title3: 25,
  headline: 22,
  body: 22,
  callout: 21,
  subhead: 20,
  footnote: 18,
  caption1: 16,
  caption2: 13,
} as const;

/**
 * Standard corner radii used by iOS for grouped lists, sheets, buttons.
 */
export const radius = {
  card: 10, // inset-grouped section
  sheet: 14,
  button: 12,
  pill: 999,
} as const;
