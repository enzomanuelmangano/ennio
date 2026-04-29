import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type PropsWithChildren,
} from 'react';
import { startServer, stopServer, isNativeModuleAvailable, DEFAULT_PORT } from '@tasto/nitro';

/**
 * Props for the TastoProvider component
 */
export interface TastoProviderProps {
  /**
   * Port number for the WebSocket server
   * @default 9876
   */
  port?: number;

  /**
   * Whether to enable the server
   * Defaults to true in __DEV__ mode, false in production
   */
  enabled?: boolean;

  /**
   * Callback when server starts successfully
   */
  onServerStart?: () => void;

  /**
   * Callback when server fails to start
   */
  onServerError?: (error: Error) => void;
}

/**
 * Context value for Tasto
 */
export interface TastoContextValue {
  /**
   * Whether the server is currently running
   */
  isRunning: boolean;

  /**
   * Port the server is running on
   */
  port: number;

  /**
   * Whether the native module is available
   */
  isAvailable: boolean;

  /**
   * Start the server manually
   */
  start: () => void;

  /**
   * Stop the server manually
   */
  stop: () => void;
}

const TastoContext = createContext<TastoContextValue | null>(null);

/**
 * TastoProvider - Wraps your app to enable E2E testing capabilities
 *
 * In development mode (__DEV__), this automatically starts the Tasto
 * WebSocket server, allowing the test runner to connect and control the app.
 *
 * In production, this component is a no-op and doesn't include any testing code.
 *
 * @example
 * ```tsx
 * import { TastoProvider } from '@tasto/app';
 *
 * export default function App() {
 *   return (
 *     <TastoProvider>
 *       <YourApp />
 *     </TastoProvider>
 *   );
 * }
 * ```
 */
export function TastoProvider({
  children,
  port = DEFAULT_PORT,
  enabled,
  onServerStart,
  onServerError,
}: PropsWithChildren<TastoProviderProps>): React.ReactElement {
  const [isRunning, setIsRunning] = useState(false);
  const [isAvailable] = useState(() => isNativeModuleAvailable());

  // Default to enabled in DEV mode
  const shouldEnable = enabled ?? __DEV__;

  const start = useCallback(() => {
    if (isRunning || !isAvailable) {
      return;
    }

    try {
      startServer(port);
      setIsRunning(true);
      onServerStart?.();

      if (__DEV__) {
        console.log(`[Tasto] Server started on port ${port}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onServerError?.(err);

      if (__DEV__) {
        console.error('[Tasto] Failed to start server:', err.message);
      }
    }
  }, [port, isRunning, isAvailable, onServerStart, onServerError]);

  const stop = useCallback(() => {
    if (!isRunning || !isAvailable) {
      return;
    }

    try {
      stopServer();
      setIsRunning(false);

      if (__DEV__) {
        console.log('[Tasto] Server stopped');
      }
    } catch (error) {
      if (__DEV__) {
        console.error('[Tasto] Failed to stop server:', error);
      }
    }
  }, [isRunning, isAvailable]);

  // Auto-start in DEV mode if native module is available
  useEffect(() => {
    if (shouldEnable && isAvailable) {
      start();
    }

    return () => {
      if (shouldEnable && isRunning && isAvailable) {
        stop();
      }
    };
  }, [shouldEnable, isAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

  const contextValue: TastoContextValue = {
    isRunning,
    port,
    isAvailable,
    start,
    stop,
  };

  return (
    <TastoContext.Provider value={contextValue}>
      {children}
    </TastoContext.Provider>
  );
}

/**
 * Hook to access Tasto context
 *
 * @example
 * ```tsx
 * function DebugPanel() {
 *   const { isRunning, port, isAvailable, start, stop } = useTasto();
 *
 *   return (
 *     <View>
 *       <Text>Tasto: {isRunning ? 'Running' : 'Stopped'}</Text>
 *       <Text>Port: {port}</Text>
 *       <Text>Available: {isAvailable ? 'Yes' : 'No'}</Text>
 *     </View>
 *   );
 * }
 * ```
 */
export function useTasto(): TastoContextValue {
  const context = useContext(TastoContext);

  if (!context) {
    throw new Error('useTasto must be used within a TastoProvider');
  }

  return context;
}
