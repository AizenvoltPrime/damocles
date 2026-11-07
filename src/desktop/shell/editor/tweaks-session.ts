import { reactive } from 'vue';
import type { TweakControl, TweaksDeclaration } from '../../../shared/types/design';

// A tab's Tweaks column: whether it is open and what Keep already sent, held in shell memory per tab until its real close
// (onDesignPreviewClosed). What is applied is main's (ShellDesignPreview.tweaks), never this.
export interface TweaksSession {
  open: boolean;
  // the declaration the kept values belong to, and per control id the token Keep sent
  keptFor: string | null;
  kept: Record<string, string>;
}

const sessions = reactive(new Map<string, TweaksSession>());

/** The tab's session, or none before its Tweaks first opened; a read only, so computeds may call it. */
export function tweaksSession(tabId: string): TweaksSession | undefined {
  return sessions.get(tabId);
}

/** The tab's session, made on first use; only an event handler writes it. */
export function ensureTweaksSession(tabId: string): TweaksSession {
  if (!sessions.has(tabId)) sessions.set(tabId, { open: false, keptFor: null, kept: {} });
  return sessions.get(tabId)!;
}

export function dropTweaksSession(tabId: string): void {
  sessions.delete(tabId);
}

export function keptValue(session: TweaksSession | undefined, declaration: TweaksDeclaration, control: TweakControl): string | undefined {
  return session?.keptFor === declaration.toolCallId ? session.kept[control.id] : undefined;
}

export function markKept(session: TweaksSession, declaration: TweaksDeclaration, control: TweakControl, token: string): void {
  if (session.keptFor !== declaration.toolCallId) {
    session.keptFor = declaration.toolCallId;
    session.kept = {};
  }
  session.kept[control.id] = token;
}

// The controls Keep sends, in declaration order: unlocked, applied, and not already kept at that stop.
export function changedControls(session: TweaksSession | undefined, declaration: TweaksDeclaration, applied: Readonly<Record<string, string>>): { control: TweakControl; token: string }[] {
  return declaration.controls.flatMap((control) => {
    const token = applied[control.property];
    if (control.locked || token === undefined || !control.stops.some((stop) => stop.token === token)) return [];
    return keptValue(session, declaration, control) === token ? [] : [{ control, token }];
  });
}

// A stop's short name: its token less the property's prefix ('--radius-lg' of '--radius' is 'lg'), else the token less '--'.
export function stopLabel(property: string, token: string): string {
  return token.startsWith(`${property}-`) && token.length > property.length + 1 ? token.slice(property.length + 1) : token.replace(/^--/, '');
}
