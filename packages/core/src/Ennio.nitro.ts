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
 * Direction for scroll / swipe gestures
 */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

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
 * Ennio HybridObject - Direct Fabric shadow tree access for E2E testing
 */
export interface Ennio extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
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

  // ============================================
  // In-app writes (no HID, no out-of-process driver)
  //
  // All actions resolve a UIView by accessibilityIdentifier (testID) and
  // drive sanctioned-ish UIKit APIs:
  //   - tap        -> UIView.accessibilityActivate
  //   - typeText   -> [textInput insertText:]
  //   - clearText  -> setText:@"" + delegate fire
  //   - eraseText  -> deleteBackward × n
  //   - scroll     -> UIScrollView.setContentOffset(animated:NO)
  //   - alerts     -> walk UIAlertController.actions, invoke handler
  //   - back       -> UINavigationController.popViewController
  //
  // Skips iOS gesture recognizer entirely. Reliable for the standard
  // RN component set (Pressable, Touchable*, TextInput, ScrollView,
  // FlatList, native iOS alert). Will not work for RN-gesture-handler-
  // driven gestures (pinch, pan, swipe-to-dismiss) — use --stable for
  // flows that exercise those.
  // ============================================

  tap(testID: string): boolean;
  /**
   * Walk the UIKit view tree (not the Fabric shadow tree) looking for any
   * UIView whose accessibilityLabel matches `text` and invoke
   * accessibilityActivate on it. This is the only way to hit native UIKit
   * elements that don't appear in the React shadow tree — UITabBar items,
   * UIAlertController buttons, system pickers, etc.
   */
  tapByLabel(text: string): boolean;
  doubleTap(testID: string): boolean;
  longPress(testID: string, durationMs: number): boolean;
  typeText(testID: string, text: string): boolean;
  clearText(testID: string): boolean;
  eraseText(testID: string, count: number): boolean;
  pressKey(testID: string, keyName: string): boolean;
  scroll(testID: string, direction: ScrollDirection, distance: number): boolean;
  swipe(testID: string, direction: ScrollDirection, distance: number): boolean;
  scrollTo(scrollViewTestID: string, elementTestID: string): boolean;

  /**
   * Synthesize a pan gesture from (x1,y1) to (x2,y2) over `durationMs`.
   * If the start point hits a UIScrollView, takes the fast path
   * (`setContentOffset:animated:NO` with the delta) — no UITouch tax.
   * Otherwise drives a UITouchPhaseMoved loop for cross-view drags
   * (sheet dismiss, page swipe, non-scrollable carousel pan).
   * Coordinates are window-relative. Sim-only (UITouch private API).
   */
  swipeAtPoints(x1: number, y1: number, x2: number, y2: number, durationMs: number): boolean;

  /**
   * Synthesize a hardware key press by HID keycode against the current
   * first responder when it conforms to UIKeyInput. Currently maps:
   *   42 → deleteBackward (backspace)
   *   40 → insertText("\n") (return)
   *   44 → insertText(" ") (space)
   * Returns false when no first responder accepts text input. Replaces
   * idb's HID `pressKey` for in-app text fields.
   */
  pressHardwareKey(keyCode: number): boolean;

  /**
   * Tap the n-th tab in the topmost UITabBar. 0-indexed left to right.
   * RN's NativeTabs items don't expose their accessibilityIdentifier on
   * the underlying UITabBarItem reliably, so we index instead.
   */
  tapTab(index: number): boolean;

  /**
   * Drive a back navigation. Pops the top view controller of the
   * current UINavigationController.
   */
  backGesture(): boolean;

  hideKeyboard(): boolean;

  // Selector-aware variants. Underlying impl resolves the selector
  // through the same shadow-tree finder as findBySelector, then
  // applies the matching write to the resolved testID.
  tapBySelector(selectorJson: string): boolean;
  doubleTapBySelector(selectorJson: string): boolean;
  longPressBySelector(selectorJson: string, durationMs: number): boolean;
  typeTextBySelector(selectorJson: string, text: string): boolean;
  clearTextBySelector(selectorJson: string): boolean;

  // Alert writes (the matching reads — isAlertPresent, getAlertText,
  // getAlertButtons — already exist above).
  tapAlertButton(buttonText: string): boolean;
  dismissAlert(): boolean;

  // Pasteboard
  copyToClipboard(text: string): boolean;
  pasteFromClipboard(testID: string): boolean;
  getClipboardText(): string;
}
