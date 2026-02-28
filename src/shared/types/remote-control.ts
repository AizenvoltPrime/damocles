export type RemoteControlConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RemoteControlStatus {
  enabled: boolean;
  connectionState: RemoteControlConnectionState;
  sessionUrl: string | null;
  connectUrl: string | null;
  environmentId: string | null;
  error: string | null;
}
