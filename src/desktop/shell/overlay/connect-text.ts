import { CLOCK_SKEW_WARN_MS, SHARED_HOME_SEPARATOR, type ConnectFailure, type HostCardInfo, type HostDevice, type HostNotice, type HostParseRefusal } from '../../preload/overlay-channels';

// plural: picks the message's plural form for that count
type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string;

// Failures the host card answers with an install folder field.
const INSTALL_FOLDER_FAILURES: ReadonlySet<string> = new Set(['noexec', 'lowSpace', 'installFolderInvalid', 'installFolderUnsafe']);

export function needsInstallFolder(failure: ConnectFailure | undefined): boolean {
  return failure !== undefined && INSTALL_FOLDER_FAILURES.has(failure.code);
}

/** A failure main reported as a code, in the user's language; name is this computer's name for the host. */
export function failureText(failure: ConnectFailure, name: string, t: Translate): string {
  return t(`remote.failure.${failureKey(failure)}`, { ...failure.params, name });
}

// A code whose reason changes what the user should do has its own text.
function failureKey(failure: ConnectFailure): string {
  const reason = failure.params.reason;
  if (failure.code === 'noexec' && reason === 'notWritable') return 'noexecNotWritable';
  if (failure.code === 'unknown' && (reason === 'sshMissing' || reason === 'noPackage')) return `unknown_${reason}`;
  if (failure.code === 'permissionDenied' && typeof failure.params.hop === 'string') return 'permissionDenied_hop';
  return failure.code;
}

/** The text of a "+ New host" entry main refused, by its reason; a destination's failed part (host, user, port) has its own. */
export function refusalText(refusal: { readonly refused: string; readonly reason: HostParseRefusal }, t: Translate): string {
  const key = refusal.reason === 'destination' && refusal.refused !== 'destination' ? `destination_${refusal.refused}` : refusal.reason;
  return t(`remote.connect.refusal.${key}`, { option: refusal.refused });
}

// Refusals of text that may still become a command as the user types show only when no card matches it as a search.
const DEFINITE_REFUSALS: ReadonlySet<HostParseRefusal> = new Set(['option', 'fixed', 'value', 'relativePath', 'conflict', 'typography']);

export function isDefiniteRefusal(reason: HostParseRefusal): boolean {
  return DEFINITE_REFUSALS.has(reason);
}

export interface NoticeView {
  readonly key: string;
  readonly text: string;
  // a command the user runs on the host themselves, shown as code
  readonly command?: string;
}

function noticeView(notice: HostNotice, name: string, t: Translate, locale: string): NoticeView {
  if (notice.code === 'sharedHome') {
    const others = String(notice.params.hosts ?? '').split(SHARED_HOME_SEPARATOR);
    return { key: notice.code, text: t('remote.notice.sharedHome', { others: new Intl.ListFormat(locale, { type: 'conjunction' }).format(others), name }, others.length) };
  }
  const text = t(`remote.notice.${notice.code}`, { ...notice.params, name });
  const suggested = notice.params.suggested;
  return notice.code === 'watchLimit' && suggested !== undefined
    ? { key: notice.code, text, command: `sudo sysctl fs.inotify.max_user_watches=${suggested}` }
    : { key: notice.code, text };
}

/** The probe's notices, then the clock skew warning once the handshake measured more than CLOCK_SKEW_WARN_MS. */
export function hostNotices(host: Pick<HostCardInfo, 'name' | 'notices' | 'clockSkewMs'>, t: Translate, locale: string): NoticeView[] {
  const views = host.notices.map((notice) => noticeView(notice, host.name, t, locale));
  const skew = host.clockSkewMs;
  if (skew !== undefined && Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
    const minutes = Math.round(Math.abs(skew) / 60_000);
    views.push({ key: 'clockSkew', text: t(skew > 0 ? 'remote.notice.clockAhead' : 'remote.notice.clockBehind', { name: host.name, minutes }) });
  }
  return views;
}

/** The devices attached to a host besides this one. */
export function otherDeviceCount(devices: readonly HostDevice[] | undefined): number {
  return devices?.filter((device) => !device.self).length ?? 0;
}

/** Attached devices go by different names, so people likely share one server account. */
export function devicesDiffer(devices: readonly HostDevice[] | undefined): boolean {
  return new Set(devices?.map((device) => device.deviceName)).size > 1;
}
