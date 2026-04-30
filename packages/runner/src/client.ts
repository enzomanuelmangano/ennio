import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type {
  ConnectionOptions,
  TastoRequest,
  TastoResponse,
  ElementInfo,
  LayoutMetrics,
  ScrollDirection,
} from './types';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 9876;
const DEFAULT_TIMEOUT = 30000;

type PendingRequest = {
  resolve: (response: TastoResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

/**
 * WebSocket client for communicating with the Tasto native server
 */
export class TastoClient {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private host: string;
  private port: number;
  private timeout: number;
  private connected: boolean = false;

  constructor(options: ConnectionOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Connect to the Tasto server
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}`;
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error(`Connection timeout to ${url}`));
      }, this.timeout);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message}`));
      });

      this.ws.on('close', () => {
        this.connected = false;
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Connection closed'));
          this.pendingRequests.delete(id);
        }
      });
    });
  }

  /**
   * Disconnect from the Tasto server
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a command to the server and wait for response
   */
  private async send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error('Not connected to Tasto server');
    }

    const id = randomUUID();
    const request: TastoRequest = { id, type, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: (response: TastoResponse) => {
          if (response.success) {
            resolve(response.data as T);
          } else {
            reject(new Error(response.error ?? 'Unknown error'));
          }
        },
        reject,
        timeout,
      });

      this.ws!.send(JSON.stringify(request));
    });
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(data: string): void {
    try {
      const response: TastoResponse = JSON.parse(data);
      const pending = this.pendingRequests.get(response.id);

      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    } catch (error) {
      console.error('Failed to parse response:', error);
    }
  }

  // ============================================
  // Element Queries
  // ============================================

  /**
   * Find an element by testID
   */
  async findByTestID(testID: string): Promise<ElementInfo | null> {
    try {
      return await this.send<ElementInfo>('findByTestID', { testID });
    } catch {
      return null;
    }
  }

  /**
   * Check if an element exists
   */
  async exists(testID: string): Promise<boolean> {
    return await this.send<boolean>('exists', { testID });
  }

  /**
   * Check if an element is visible
   */
  async isVisible(testID: string): Promise<boolean> {
    return await this.send<boolean>('isVisible', { testID });
  }

  /**
   * Get layout metrics for an element
   */
  async getLayoutMetrics(testID: string): Promise<LayoutMetrics | null> {
    try {
      return await this.send<LayoutMetrics>('getLayoutMetrics', { testID });
    } catch {
      return null;
    }
  }

  /**
   * Get text content of an element
   */
  async getText(testID: string): Promise<string | null> {
    try {
      return await this.send<string>('getText', { testID });
    } catch {
      return null;
    }
  }

  // ============================================
  // Actions
  // ============================================

  /**
   * Tap on an element
   */
  async tap(testID: string): Promise<void> {
    await this.send<void>('tap', { testID });
  }

  /**
   * Long press on an element
   */
  async longPress(testID: string, durationMs: number = 500): Promise<void> {
    await this.send<void>('longPress', { testID, durationMs });
  }

  /**
   * Type text into an input
   */
  async typeText(testID: string, text: string): Promise<void> {
    await this.send<void>('typeText', { testID, text });
  }

  /**
   * Clear text from an input
   */
  async clearText(testID: string): Promise<void> {
    await this.send<void>('clearText', { testID });
  }

  /**
   * Replace text in an input
   */
  async replaceText(testID: string, text: string): Promise<void> {
    await this.send<void>('replaceText', { testID, text });
  }

  /**
   * Scroll a ScrollView
   */
  async scroll(testID: string, deltaX: number, deltaY: number): Promise<void> {
    await this.send<void>('scroll', { testID, deltaX, deltaY });
  }

  /**
   * Scroll to make a child element visible
   */
  async scrollTo(scrollViewTestID: string, elementTestID: string): Promise<void> {
    await this.send<void>('scrollTo', { scrollViewTestID, elementTestID });
  }

  /**
   * Scroll to a specific index
   */
  async scrollToIndex(testID: string, index: number): Promise<void> {
    await this.send<void>('scrollToIndex', { testID, index });
  }

  /**
   * Swipe on an element
   */
  async swipe(
    testID: string,
    direction: ScrollDirection,
    distance: number
  ): Promise<void> {
    await this.send<void>('swipe', { testID, direction, distance });
  }

  // ============================================
  // Synchronization
  // ============================================

  /**
   * Wait for the app to be idle
   */
  async waitForIdle(timeoutMs: number = 5000): Promise<boolean> {
    return await this.send<boolean>('waitForIdle', { timeoutMs });
  }

  /**
   * Force synchronization
   */
  async synchronize(): Promise<void> {
    await this.send<void>('synchronize', {});
  }

  // ============================================
  // Alert/Modal Handling
  // ============================================

  /**
   * Check if an alert is currently present
   */
  async isAlertPresent(): Promise<boolean> {
    return await this.send<boolean>('isAlertPresent', {});
  }

  /**
   * Get the text of the current alert (title + message)
   */
  async getAlertText(): Promise<string> {
    return await this.send<string>('getAlertText', {});
  }

  /**
   * Get the button titles of the current alert
   */
  async getAlertButtons(): Promise<string[]> {
    return await this.send<string[]>('getAlertButtons', {});
  }

  /**
   * Tap an alert button by its text
   */
  async tapAlertButton(buttonText: string): Promise<void> {
    await this.send<void>('tapAlertButton', { buttonText });
  }

  /**
   * Dismiss the current alert
   */
  async dismissAlert(): Promise<void> {
    await this.send<void>('dismissAlert', {});
  }
}

// Global client instance
let globalClient: TastoClient | null = null;

/**
 * Get or create the global client instance
 */
export function getClient(options?: ConnectionOptions): TastoClient {
  if (!globalClient) {
    globalClient = new TastoClient(options);
  }
  return globalClient;
}

/**
 * Connect the global client
 */
export async function connect(options?: ConnectionOptions): Promise<TastoClient> {
  const client = getClient(options);
  await client.connect();
  return client;
}

/**
 * Disconnect the global client
 */
export function disconnect(): void {
  if (globalClient) {
    globalClient.disconnect();
    globalClient = null;
  }
}
