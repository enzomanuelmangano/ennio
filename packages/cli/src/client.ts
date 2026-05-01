/**
 * Tasto WebSocket Client
 *
 * Connects directly to the native Tasto WebSocket server
 * running in the app. Works in both debug and release builds.
 */

const DEFAULT_PORT = 9876;

interface TastoRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

interface TastoResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export class TastoClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (r: TastoResponse) => void; reject: (e: Error) => void }>();
  private messageId = 0;
  private port: number;

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:${this.port}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`Failed to connect to Tasto server on port ${this.port}`));

      this.ws.onmessage = (event) => {
        try {
          const response: TastoResponse = JSON.parse(event.data as string);
          const handler = this.pending.get(response.id);
          if (handler) {
            this.pending.delete(response.id);
            handler.resolve(response);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        // Reject all pending requests
        for (const [id, handler] of this.pending) {
          handler.reject(new Error('Connection closed'));
          this.pending.delete(id);
        }
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async send(type: string, payload: Record<string, unknown> = {}): Promise<TastoResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Tasto server');
    }

    const id = String(++this.messageId);
    const request: TastoRequest = { id, type, payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(request));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, 30000);
    });
  }

  // Element queries
  async exists(testID: string): Promise<boolean> {
    const response = await this.send('exists', { testID });
    return response.data === true || response.data === 'true';
  }

  async isVisible(testID: string): Promise<boolean> {
    const response = await this.send('isVisible', { testID });
    return response.data === true || response.data === 'true';
  }

  async getText(testID: string): Promise<string | null> {
    const response = await this.send('getText', { testID });
    if (response.data === null || response.data === 'null') return null;
    return typeof response.data === 'string' ? response.data.replace(/^"|"$/g, '') : null;
  }

  // Actions
  async tap(testID: string): Promise<boolean> {
    const response = await this.send('tap', { testID });
    return response.success;
  }

  async typeText(testID: string, text: string): Promise<boolean> {
    const response = await this.send('typeText', { testID, text });
    return response.success;
  }

  async clearText(testID: string): Promise<boolean> {
    const response = await this.send('clearText', { testID });
    return response.success;
  }

  async scroll(testID: string, direction: string, amount: number): Promise<boolean> {
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const response = await this.send('scroll', { testID, deltaX, deltaY });
    return response.success;
  }

  // Synchronization
  async waitForIdle(timeout: number = 5000): Promise<boolean> {
    const response = await this.send('waitForIdle', { timeout });
    return response.success;
  }

  async synchronize(): Promise<void> {
    await this.send('synchronize', {});
  }

  // Alert handling
  async isAlertPresent(): Promise<boolean> {
    const response = await this.send('isAlertPresent', {});
    return response.data === true || response.data === 'true';
  }

  async getAlertText(): Promise<string> {
    const response = await this.send('getAlertText', {});
    return typeof response.data === 'string' ? response.data.replace(/^"|"$/g, '') : '';
  }

  async tapAlertButton(buttonText: string): Promise<boolean> {
    const response = await this.send('tapAlertButton', { buttonText });
    return response.success;
  }

  async dismissAlert(): Promise<boolean> {
    const response = await this.send('dismissAlert', {});
    return response.success;
  }
}
