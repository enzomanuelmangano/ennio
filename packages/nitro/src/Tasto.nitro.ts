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
 * Extended element info with additional state properties
 */
export interface ExtendedElementInfo extends ElementInfo {
  checked: boolean;
  focused: boolean;
  selected: boolean;
}

/**
 * Scroll direction for scroll operations
 */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Text matching mode for text selectors
 */
export type TextMatchMode = 'exact' | 'contains' | 'regex' | 'startsWith' | 'endsWith';

/**
 * Text matcher configuration
 */
export interface TextMatcher {
  pattern: string;
  mode?: TextMatchMode;
}

/**
 * Point for coordinate-based selection
 */
export interface Point {
  x: number;
  y: number;
  isPercentage?: boolean;
}

/**
 * Trait types for trait-based selection
 */
export type Trait = 'text' | 'long-text' | 'square';

/**
 * Selector - Full Maestro selector parity
 *
 * Supports:
 * - Primary: id, text, index, point
 * - State: enabled, checked, focused, selected
 * - Spatial: below, above, leftOf, rightOf
 * - Hierarchical: containsChild, childOf, containsDescendants
 * - Dimensions: width, height, tolerance
 * - Traits: text, long-text, square
 */
export interface Selector {
  // ============================================
  // Primary Selectors
  // ============================================

  /**
   * Match by testID (O(1) lookup when used alone)
   */
  id?: string;

  /**
   * Match by text content (string for exact match, or TextMatcher for advanced)
   */
  text?: string | TextMatcher;

  /**
   * Return the nth matching element (0-indexed)
   */
  index?: number;

  /**
   * Select element at specific coordinates
   * String format: "50%,50%" or "100,200"
   */
  point?: Point | string;

  // ============================================
  // State Selectors
  // ============================================

  /**
   * Match by enabled state
   */
  enabled?: boolean;

  /**
   * Match by checked state (checkboxes, switches)
   */
  checked?: boolean;

  /**
   * Match by focused state
   */
  focused?: boolean;

  /**
   * Match by selected state
   */
  selected?: boolean;

  // ============================================
  // Spatial Selectors (relative positioning)
  // ============================================

  /**
   * Match elements below the reference element
   */
  below?: Selector;

  /**
   * Match elements above the reference element
   */
  above?: Selector;

  /**
   * Match elements to the left of the reference element
   */
  leftOf?: Selector;

  /**
   * Match elements to the right of the reference element
   */
  rightOf?: Selector;

  // ============================================
  // Hierarchical Selectors
  // ============================================

  /**
   * Match elements that contain a direct child matching criteria
   */
  containsChild?: Selector;

  /**
   * Match elements that are children of an element matching criteria
   */
  childOf?: Selector;

  /**
   * Match elements that contain all descendants matching each criteria
   */
  containsDescendants?: Selector[];

  // ============================================
  // Dimension Selectors
  // ============================================

  /**
   * Match by width (in points)
   */
  width?: number;

  /**
   * Match by height (in points)
   */
  height?: number;

  /**
   * Tolerance for width/height matching (default: 0)
   */
  tolerance?: number;

  // ============================================
  // Trait Selectors
  // ============================================

  /**
   * Match elements with specified traits
   */
  traits?: Trait[];
}

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
   * Simulate a double tap on an element
   * @param testID - The testID prop value
   * @returns true if double tap was dispatched successfully
   */
  doubleTap(testID: string): boolean;

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

  // ============================================
  // Selector-based Queries (Full Maestro Parity)
  // ============================================

  /**
   * Find an element using a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @returns ExtendedElementInfo if found, null otherwise
   */
  findBySelector(selectorJson: string): ExtendedElementInfo | null;

  /**
   * Find all elements matching a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @returns Array of ExtendedElementInfo
   */
  findAllBySelector(selectorJson: string): ExtendedElementInfo[];

  /**
   * Check if an element matching the selector exists
   * @param selectorJson - JSON-encoded Selector object
   */
  existsBySelector(selectorJson: string): boolean;

  /**
   * Tap an element using a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @returns true if tap was dispatched successfully
   */
  tapBySelector(selectorJson: string): boolean;

  /**
   * Type text into an element using a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @param text - Text to type
   * @returns true if text was entered successfully
   */
  typeTextBySelector(selectorJson: string, text: string): boolean;

  /**
   * Clear text from an element using a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @returns true if text was cleared successfully
   */
  clearTextBySelector(selectorJson: string): boolean;

  /**
   * Long press an element using a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @param durationMs - Duration of long press in milliseconds
   * @returns true if long press was dispatched successfully
   */
  longPressBySelector(selectorJson: string, durationMs: number): boolean;

  /**
   * Get text content of an element using a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @returns Text content if available, null otherwise
   */
  getTextBySelector(selectorJson: string): string | null;

  /**
   * Check if an element matching the selector is visible
   * @param selectorJson - JSON-encoded Selector object
   */
  isVisibleBySelector(selectorJson: string): boolean;

  /**
   * Double tap an element using a selector (JSON string)
   * @param selectorJson - JSON-encoded Selector object
   * @returns true if double tap was dispatched successfully
   */
  doubleTapBySelector(selectorJson: string): boolean;

  // ============================================
  // Alert/Modal Handling
  // ============================================

  /**
   * Check if an alert is currently presented
   */
  isAlertPresent(): boolean;

  /**
   * Get the text content of the current alert (title + message)
   */
  getAlertText(): string;

  /**
   * Get the button titles of the current alert
   */
  getAlertButtons(): string[];

  /**
   * Tap an alert button by its text
   * @param buttonText - The button title to tap
   * @returns true if successful
   */
  tapAlertButton(buttonText: string): boolean;

  /**
   * Dismiss the current alert (taps cancel/OK button)
   */
  dismissAlert(): boolean;

  // ============================================
  // Keyboard Handling
  // ============================================

  /**
   * Hide the keyboard by resigning first responder
   */
  hideKeyboard(): boolean;

  /**
   * Erase text by sending backspace key events
   * @param count - Number of characters to erase
   */
  eraseText(count: number): boolean;

  /**
   * Press a key by name (e.g., "Enter", "Tab", "Escape")
   * @param keyName - The key to press
   */
  pressKey(keyName: string): boolean;

  // ============================================
  // Clipboard Handling
  // ============================================

  /**
   * Copy text to clipboard
   * @param text - Text to copy
   */
  copyToClipboard(text: string): boolean;

  /**
   * Paste from clipboard into the focused text field
   */
  pasteFromClipboard(): boolean;

  /**
   * Get current clipboard contents
   */
  getClipboardText(): string;

  // ============================================
  // Device Control
  // ============================================

  /**
   * Set device orientation
   * @param orientation - 0=portrait, 1=portraitUpsideDown, 2=landscapeLeft, 3=landscapeRight
   */
  setOrientation(orientation: number): boolean;

  /**
   * Perform a swipe gesture between coordinates
   * @param startX - Start X coordinate
   * @param startY - Start Y coordinate
   * @param endX - End X coordinate
   * @param endY - End Y coordinate
   * @param durationMs - Duration of swipe in milliseconds
   */
  swipeCoordinates(startX: number, startY: number, endX: number, endY: number, durationMs: number): boolean;

  /**
   * Simulate back gesture (swipe from left edge on iOS)
   */
  backGesture(): boolean;
}
