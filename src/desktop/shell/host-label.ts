import type { HostLatency, HostReconnect } from '@shared/host-connection';
import type { ProjectConnection } from '../preload/shell-channels';

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface LabelledHost {
  readonly name: string;
  readonly connection: ProjectConnection;
  readonly reconnect?: HostReconnect | undefined;
  readonly latency?: HostLatency | undefined;
}

/** A host and its state as one phrase, for its dot's name and tooltip: "prod-1 · 38 ms", "Slow connection to prod-1 (620 ms)". */
export function hostStateLabel(host: LabelledHost, t: Translate): string {
  if (host.reconnect) return t('projects.hostState', { host: host.name, state: t(host.reconnect.phase === 'failed' ? 'projects.connection.reconnectFailed' : 'projects.connection.reconnecting') });
  if (host.connection === 'connected' && host.latency) {
    const ms = Math.round(host.latency.latencyMs);
    return host.latency.slow ? t('projects.slowConnection', { host: host.name, ms }) : t('projects.latency', { host: host.name, ms });
  }
  return t('projects.hostState', { host: host.name, state: t(`projects.connection.${host.connection}`) });
}
