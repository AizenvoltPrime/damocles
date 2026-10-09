import { MAX_MESSAGE_PREVIEW_LINES, MAX_OVERLAY_LABEL_LENGTH } from '../../preload/overlay-channels';
import type { TerminalStatus } from '../../preload/terminal-channels';
import type { TerminalConfirmOnKill } from '../desktop-configuration';
import type { MessageQuestion } from '../message-dialog';
import type { KillListEntry } from './terminal-service';

export interface KillCandidate {
  readonly status: TerminalStatus;
  // main's running fact: a command line, a foreground process, '' for an unreported line, null for nothing
  readonly running: string | null;
}

/**
 * The terminals a kill must ask about, in the order given; none means kill without asking. `running` asks for those that
 * run something, `always` for every live one, `never` for none. An exited terminal never asks.
 */
export function terminalsToConfirm<T extends KillCandidate>(setting: TerminalConfirmOnKill, terminals: readonly T[]): T[] {
  if (setting === 'never') return [];
  const live = terminals.filter((terminal) => terminal.status !== 'exited');
  return setting === 'always' ? live : live.filter((terminal) => terminal.running !== null);
}

/**
 * VS Code's terminal close confirmation as one D41 question listing every terminal it kills: a preview line each, "name:
 * command" or the name of an idle one, the overflow folded into a last "and N more" line.
 */
export function killQuestion(entries: readonly KillListEntry[], t: (message: string, ...args: string[]) => string): MessageQuestion {
  const line = (entry: KillListEntry): string => {
    const text = entry.command === null || entry.command === '' ? entry.name : `${entry.name}: ${entry.command}`;
    return text.length <= MAX_OVERLAY_LABEL_LENGTH ? text : `${text.slice(0, MAX_OVERLAY_LABEL_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
  };
  const fits = entries.length <= MAX_MESSAGE_PREVIEW_LINES;
  const shown = fits ? entries : entries.slice(0, MAX_MESSAGE_PREVIEW_LINES - 1);
  return {
    severity: 'warning',
    message: entries.length === 1 ? t('Do you want to terminate the active terminal session?') : t('Do you want to terminate the {0} active terminal sessions?', String(entries.length)),
    detail: entries.length === 1 ? t('Its shell and anything running in it stop.') : t('Their shells and anything running in them stop.'),
    preview: [...shown.map(line), ...(fits ? [] : [t('and {0} more', String(entries.length - shown.length))])],
    actions: [t('Terminate')],
    cancelLabel: t('Cancel'),
    defaultAction: 0,
  };
}
