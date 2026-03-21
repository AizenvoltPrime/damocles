import type { ConsoleEntry, NetworkError } from '../../shared/types/browser';

const MAX_ENTRIES = 100;

export class ConsoleCollector {
  private entries: ConsoleEntry[] = [];

  handleEvent(params: {
    type: string;
    args: Array<{ type: string; value?: unknown; description?: string }>;
    timestamp: number;
  }): void {
    const text = params.args
      .map(a => (a.value !== undefined ? String(a.value) : a.description ?? ''))
      .join(' ');
    this.entries.push({
      level: params.type,
      text,
      timestamp: params.timestamp,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  getMessages(): ConsoleEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

export class NetworkCollector {
  private errors: NetworkError[] = [];

  handleResponse(params: {
    response: { url: string; status: number; statusText: string };
    timestamp: number;
  }): void {
    if (params.response.status >= 400) {
      this.errors.push({
        url: params.response.url,
        status: params.response.status,
        statusText: params.response.statusText,
        type: 'failed',
        timestamp: params.timestamp,
      });
      if (this.errors.length > MAX_ENTRIES) {
        this.errors.shift();
      }
    }
  }

  handleLoadingFailed(params: {
    requestId: string;
    timestamp: number;
    errorText: string;
    type?: string;
  }): void {
    this.errors.push({
      url: `(loading failed: ${params.errorText})`,
      type: 'error',
      timestamp: params.timestamp,
    });
    if (this.errors.length > MAX_ENTRIES) {
      this.errors.shift();
    }
  }

  getErrors(): NetworkError[] {
    return [...this.errors];
  }

  clear(): void {
    this.errors = [];
  }
}
