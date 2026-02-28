import { log } from '../logger';
import type { Query } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { RemoteControlStatus, RemoteControlConnectionState } from '../../shared/types/remote-control';

interface RemoteControlResponse {
  session_url?: string;
  connect_url?: string;
  environment_id?: string;
}

interface RemoteControlCapable {
  enableRemoteControl(enabled: boolean): Promise<RemoteControlResponse>;
}

function hasRemoteControl(query: Query): query is Query & RemoteControlCapable {
  return typeof (query as unknown as Record<string, unknown>)['enableRemoteControl'] === 'function';
}

type BroadcastFn = (message: ExtensionToWebviewMessage) => void;

export class RemoteControlManager {
  private _enabled = false;
  private _connectionState: RemoteControlConnectionState = 'disconnected';
  private _sessionUrl: string | null = null;
  private _connectUrl: string | null = null;
  private _environmentId: string | null = null;
  private _error: string | null = null;

  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  get isEnabled(): boolean {
    return this._enabled;
  }

  get status(): RemoteControlStatus {
    return {
      enabled: this._enabled,
      connectionState: this._connectionState,
      sessionUrl: this._sessionUrl,
      connectUrl: this._connectUrl,
      environmentId: this._environmentId,
      error: this._error,
    };
  }

  async enable(query: Query): Promise<void> {
    this._enabled = true;
    this._error = null;
    await this.applyToQuery(query);
  }

  async disable(query: Query): Promise<void> {
    this._enabled = false;

    if (hasRemoteControl(query)) {
      try {
        await query.enableRemoteControl(false);
        log('[RemoteControlManager] Disabled');
      } catch (err) {
        log('[RemoteControlManager] Disable failed:', err);
      }
    }

    this._connectionState = 'disconnected';
    this._sessionUrl = null;
    this._connectUrl = null;
    this._environmentId = null;
    this._error = null;
    this.broadcastStatus();
  }

  async reapplyToQuery(query: Query): Promise<void> {
    if (!this._enabled) return;

    log('[RemoteControlManager] Reapplying to new query');
    this._sessionUrl = null;
    this._connectUrl = null;
    this._environmentId = null;
    this._error = null;
    await this.applyToQuery(query);
  }

  private async applyToQuery(query: Query): Promise<void> {
    if (!hasRemoteControl(query)) {
      this._connectionState = 'error';
      this._error = 'Remote control not supported by this SDK version';
      this.broadcastStatus();
      return;
    }

    this._connectionState = 'connecting';
    this.broadcastStatus();

    try {
      const response = await query.enableRemoteControl(true);
      this._connectionState = 'connected';
      this._sessionUrl = response.session_url ?? null;
      this._connectUrl = response.connect_url ?? null;
      this._environmentId = response.environment_id ?? null;
      log('[RemoteControlManager] Connected — connectUrl=%s', this._connectUrl);
    } catch (err) {
      this._connectionState = 'error';
      this._error = err instanceof Error ? err.message : 'Failed to enable remote control';
      log('[RemoteControlManager] Connection failed:', err);
    }

    this.broadcastStatus();
  }

  reset(): void {
    this._enabled = false;
    this._connectionState = 'disconnected';
    this._sessionUrl = null;
    this._connectUrl = null;
    this._environmentId = null;
    this._error = null;
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    this.broadcast({
      type: 'remoteControlStatusChanged',
      status: this.status,
    });
  }
}
