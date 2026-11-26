import type { HostLatency, HostReconnect, HostRemoved } from '@shared/host-connection';
import type { HostUpdate } from '@shared/host-update';
import type { ProjectConnection } from '../preload/shell-channels';
import { hostUpdateState, terminalsHold } from '@/components/banner-tone';
import { byDeadline, deadlineParts, minutesLeft, type UpdateClock } from '@/components/host-update-clock';

// a params.count picks the message's plural form
type Translate = (key: string, params?: Record<string, unknown>) => string;

interface LabelledHost {
  readonly name: string;
  readonly connection: ProjectConnection;
  readonly reconnect?: HostReconnect | undefined;
  readonly latency?: HostLatency | undefined;
  readonly update?: HostUpdate | undefined;
  readonly removed?: HostRemoved | undefined;
}

/** What a host whose server was removed says, naming the device that removed it when another device did. */
export function removedText(host: Pick<LabelledHost, 'name' | 'removed'>, t: Translate): string | undefined {
  if (!host.removed) return undefined;
  return host.removed.by !== undefined ? t('remote.removed.by', { host: host.name, device: host.removed.by }) : t('remote.removed.found', { host: host.name });
}

/** What the host's badge says of its pending switch; each state has its own pip shape and name phrase. */
export type UpdateBadge = 'pending' | 'required' | 'countdown' | 'switching' | 'appOutdated';

export function updateBadge(update: HostUpdate | undefined): UpdateBadge | undefined {
  if (!update) return undefined;
  const state = hostUpdateState(update);
  return state === 'offer' || state === 'waiting' ? 'pending' : state;
}

/** The host card's Update section's lead sentence, which the badge's tooltip also shows; the countdown in minutes left. */
export function updateLead(update: HostUpdate, t: Translate, clock: UpdateClock): string {
  const named = { from: update.serverVersion, to: update.targetVersion };
  const terminals = { ...named, count: update.runningTerminals };
  switch (hostUpdateState(update)) {
    case 'required': return t('hostUpdate.card.lead.required', { ...named, ...deadlineParts(update.required?.deadline ?? 0, clock, t) });
    case 'countdown': return t('hostUpdate.card.lead.countdown', { ...named, clock: t('hostUpdate.minutes', { count: minutesLeft((update.required?.deadline ?? 0) - clock.now()) }) });
    case 'appOutdated': return t(`hostUpdate.card.lead.${update.outdated === 'floor' ? 'floor' : 'appOutdated'}`, named);
    case 'offer': return terminalsHold(update) ? t('hostUpdate.card.lead.offerTerminals', terminals) : t('hostUpdate.card.lead.offer', named);
    case 'waiting':
      if (draining(update)) return t('hostUpdate.card.lead.drain', { ...named, time: clock.time(update.drainEndsAt) });
      return terminalsHold(update) ? t('hostUpdate.card.lead.waitingTerminals', terminals) : t('hostUpdate.card.lead.waiting', named);
    case 'switching': return t('hostUpdate.card.lead.switching', named);
  }
}


/** No agent runs, so only the bounded drain of the other devices delays the switch. */
export function draining(update: HostUpdate): update is HostUpdate & { readonly drainEndsAt: number } {
  return update.phase === 'waiting' && update.runningAgents === 0 && update.drainEndsAt !== undefined;
}

/** A state phrase and the badge's after a comma: "prod-1 · 38 ms, update pending", "Not connected, update this app". */
export function withUpdatePhrase(state: string, update: HostUpdate | undefined, t: Translate, clock: UpdateClock): string {
  const badge = updateBadge(update);
  if (badge === undefined) return state;
  const deadline = update?.required?.deadline ?? 0;
  const params = badge === 'required' ? { by: byDeadline(deadline, clock, t) } : badge === 'countdown' ? { count: minutesLeft(deadline - clock.now()) } : { to: update?.targetVersion };
  return `${state}, ${t(`projects.update.${badge}`, params)}`;
}

/** A host and its state as one phrase, for its dot's name: "prod-1 · 38 ms", "Slow connection to prod-1 (620 ms)". */
export function hostStateLabel(host: LabelledHost, t: Translate, clock: UpdateClock): string {
  const state = connectionLabel(host, t);
  return withUpdatePhrase(host.removed ? `${state}, ${t('projects.removed')}` : state, host.update, t, clock);
}

/**
 * A host dot's tooltip: its state, then on a second line that its server was removed, the card's lead sentence, or why this
 * app is below the host's floor.
 */
export function hostStateTitle(host: LabelledHost, t: Translate, clock: UpdateClock): string {
  const state = connectionLabel(host, t);
  const removed = removedText(host, t);
  if (removed !== undefined) return `${state}
${removed}`;
  if (!host.update) return state;
  const detail = host.update.outdated === 'floor' ? t('projects.update.floorTitle', { from: host.update.serverVersion }) : updateLead(host.update, t, clock);
  return `${state}
${detail}`;
}

function connectionLabel(host: LabelledHost, t: Translate): string {
  if (host.reconnect) return t('projects.hostState', { host: host.name, state: t(host.reconnect.phase === 'failed' ? 'projects.connection.reconnectFailed' : 'projects.connection.reconnecting') });
  if (host.connection === 'connected' && host.latency) {
    const ms = Math.round(host.latency.latencyMs);
    return host.latency.slow ? t('projects.slowConnection', { host: host.name, ms }) : t('projects.latency', { host: host.name, ms });
  }
  return t('projects.hostState', { host: host.name, state: t(`projects.connection.${host.connection}`) });
}

/** A host's state without its name, where the name already shows beside it: "Connected · 38 ms", "Slow connection (620 ms)". */
export function hostStatus(host: Omit<LabelledHost, 'name'>, t: Translate): string {
  if (host.reconnect) return t(host.reconnect.phase === 'failed' ? 'projects.connection.reconnectFailed' : 'projects.connection.reconnecting');
  if (host.connection === 'connected' && host.latency) {
    const ms = Math.round(host.latency.latencyMs);
    return host.latency.slow ? t('projects.slowConnectionShort', { ms }) : t('projects.latencyShort', { ms });
  }
  return t(`projects.connection.${host.connection}`);
}
