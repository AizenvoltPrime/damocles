import type { WalkIgnore } from '../shared/walk-ignore';
import type { Disposable } from './disposable';

/** The walk's switches as the host's own search settings set them (docs/invariants.md "Tool overrides"). */
export interface WalkSwitches {
  readonly ignore: WalkIgnore;
  // WalkOptions.followLinks
  readonly followLinks: boolean;
}

export interface WalkSettings {
  read(): WalkSwitches;
  // fires when a setting read() answers from may have changed
  onDidChange(cb: () => void): Disposable;
}
