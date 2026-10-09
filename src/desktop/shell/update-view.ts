import type { UpdateAction, UpdateState } from '../preload/updates';

/** What the title-bar pill shows; null hides it, since only these states ask anything of the user. */
export type PillView =
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'restarting'; readonly version: string }
  | { readonly kind: 'available'; readonly version: string };

export function pillView(state: UpdateState): PillView | null {
  switch (state.kind) {
    case 'downloading':
      return { kind: 'downloading', version: state.version, percent: state.percent };
    case 'ready':
    case 'restarting':
    case 'available':
      return { kind: state.kind, version: state.version };
    default:
      return null;
  }
}

export interface PillMenuItem {
  readonly action: Extract<UpdateAction, 'restart' | 'releaseNotes' | 'showLog'>;
  readonly disabled: boolean;
}

/** The pill's menu on Windows and Linux (the macOS pill opens the release page instead): Restart only once it is ready. */
export function pillMenu(view: Exclude<PillView, { kind: 'available' }>): readonly PillMenuItem[] {
  const ready = view.kind === 'ready';
  return [
    { action: 'restart', disabled: !ready },
    ...(ready ? [{ action: 'releaseNotes' as const, disabled: false }] : []),
    { action: 'showLog', disabled: false },
  ];
}

export type UpdateTone = 'neutral' | 'accent' | 'success' | 'danger';

/** The About status chip's colour. */
export function updateTone(state: UpdateState): UpdateTone {
  switch (state.kind) {
    case 'upToDate':
      return 'success';
    case 'error':
      return 'danger';
    case 'checking':
    case 'available':
    case 'downloading':
    case 'ready':
    case 'restarting':
      return 'accent';
    default:
      return 'neutral';
  }
}
