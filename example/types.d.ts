import 'react-native';
import 'expo-router/unstable-native-tabs';

declare module 'react-native' {
  interface ViewProps {
    accessibilityIdentifier?: string;
  }
  interface PressableProps {
    accessibilityIdentifier?: string;
  }
}

declare module 'expo-router/unstable-native-tabs' {
  interface NativeTabTriggerProps {
    testID?: string;
  }
}
