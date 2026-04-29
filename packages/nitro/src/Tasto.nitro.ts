import type { HybridObject } from 'react-native-nitro-modules';

/**
 * Layout metrics for a UI element
 */
export interface LayoutMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
}

/**
 * Information about a found element
 */
export interface ElementInfo {
  testID: string;
  type: string;
  text?: string;
  accessible: boolean;
  enabled: boolean;
  layout: LayoutMetrics;
}

/**
 * Scroll direction for scroll operations
 */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Tasto HybridObject - Direct Fabric shadow tree access for E2E testing
 */
export interface Tasto extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  // ============================================
  // Server Management
  // ============================================

  /**
   * Start the WebSocket server on the specified port
   * @param port - Port number for WebSocket server (default: 9876)
   */
  startServer(port: number): void;

  /**
   * Stop the WebSocket server
   */
  stopServer(): void;

  /**
   * Check if server is currently running
   */
  isServerRunning(): boolean;

  // ============================================
  // Element Queries
  // ============================================

  /**
   * Find an element by testID
   * @param testID - The testID prop value to search for
   * @returns ElementInfo if found, null otherwise
   */
  findByTestID(testID: string): ElementInfo | null;

  /**
   * Check if an element with the given testID exists in the tree
   * @param testID - The testID prop value to search for
   */
  exists(testID: string): boolean;

  /**
   * Get layout metrics for an element
   * @param testID - The testID prop value
   * @returns LayoutMetrics if found, null otherwise
   */
  getLayoutMetrics(testID: string): LayoutMetrics | null;

  /**
   * Check if an element is visible on screen
   * Considers: opacity, display, pointerEvents, and viewport bounds
   * @param testID - The testID prop value
   */
  isVisible(testID: string): boolean;

  /**
   * Get text content of an element
   * @param testID - The testID prop value
   * @returns Text content if available, null otherwise
   */
  getText(testID: string): string | null;

  // ============================================
  // Actions
  // ============================================

  /**
   * Simulate a tap on an element
   * @param testID - The testID prop value
   * @returns true if tap was dispatched successfully
   */
  tap(testID: string): boolean;

  /**
   * Simulate a long press on an element
   * @param testID - The testID prop value
   * @param durationMs - Duration of long press in milliseconds
   * @returns true if long press was dispatched successfully
   */
  longPress(testID: string, durationMs: number): boolean;

  /**
   * Type text into a TextInput element
   * @param testID - The testID prop value
   * @param text - Text to type
   * @returns true if text was entered successfully
   */
  typeText(testID: string, text: string): boolean;

  /**
   * Clear text from a TextInput element
   * @param testID - The testID prop value
   * @returns true if text was cleared successfully
   */
  clearText(testID: string): boolean;

  /**
   * Replace text in a TextInput element
   * @param testID - The testID prop value
   * @param text - New text to set
   * @returns true if text was replaced successfully
   */
  replaceText(testID: string, text: string): boolean;

  /**
   * Scroll a ScrollView by delta values
   * @param testID - The testID prop of the ScrollView
   * @param deltaX - Horizontal scroll delta (positive = right)
   * @param deltaY - Vertical scroll delta (positive = down)
   * @returns true if scroll was dispatched successfully
   */
  scroll(testID: string, deltaX: number, deltaY: number): boolean;

  /**
   * Scroll to make a child element visible
   * @param scrollViewTestID - The testID of the ScrollView
   * @param elementTestID - The testID of the element to scroll to
   * @returns true if scroll was dispatched successfully
   */
  scrollTo(scrollViewTestID: string, elementTestID: string): boolean;

  /**
   * Scroll a list to a specific index
   * @param testID - The testID of the FlatList/SectionList
   * @param index - Index to scroll to
   * @returns true if scroll was dispatched successfully
   */
  scrollToIndex(testID: string, index: number): boolean;

  /**
   * Perform a swipe gesture
   * @param testID - The testID of the element
   * @param direction - Direction of swipe
   * @param distance - Distance to swipe in points
   * @returns true if swipe was dispatched successfully
   */
  swipe(testID: string, direction: ScrollDirection, distance: number): boolean;

  // ============================================
  // Synchronization
  // ============================================

  /**
   * Wait for the shadow tree to settle (no pending updates)
   * @param timeoutMs - Maximum time to wait in milliseconds
   * @returns true if settled within timeout
   */
  waitForIdle(timeoutMs: number): boolean;

  /**
   * Force a synchronization point - ensures all pending JS and native updates are processed
   */
  synchronize(): void;
}
