import { describe, expect, it, vi } from 'vitest';
import { createDesktopLocalizationService } from '../../local-services/localization-service';
import { chatMutationResult, type ChatMutationDeps } from '../chat-mutation-result';
import type { LocalizedText } from '../../../shared/localized-text';

// a key l10n/bundle.l10n.el.json translates, so the Greek toast differs from the English log line
const NAME_TOO_LONG: LocalizedText = { message: 'A session name must be 1 to {0} characters.', args: [200] };

function deps() {
  const el = createDesktopLocalizationService(process.cwd(), 'el', () => undefined);
  const lines: string[] = [];
  const toasts: string[] = [];
  const missing = vi.fn(() => ({ ok: false, reason: 'missing' }) as const);
  const chatDeps: ChatMutationDeps = {
    log: (line) => lines.push(line),
    t: (message, ...args) => el.t(message, ...args),
    render: (text) => el.render(text),
    error: (message) => toasts.push(message),
    missing,
  };
  return { el, chatDeps, lines, toasts, missing };
}

describe('chatMutationResult', () => {
  it('logs a failure in English and toasts it once in the user\'s language', () => {
    const { el, chatDeps, lines, toasts } = deps();
    expect(chatMutationResult({ ok: false, reason: 'failed', message: NAME_TOO_LONG }, 'rename', chatDeps)).toEqual({ ok: false, reason: 'failed' });
    expect(lines).toEqual(['[chats] rename failed: A session name must be 1 to 200 characters.']);
    const greek = el.render(NAME_TOO_LONG);
    expect(greek).not.toContain('A session name must be');
    expect(toasts).toEqual([el.t('Damocles could not change the session: {0}', greek)]);
    expect(toasts[0]).not.toContain('Damocles could not change the session');
  });

  it('toasts an invalid request\'s own message, without the failure headline', () => {
    const { el, chatDeps, lines, toasts } = deps();
    chatMutationResult({ ok: false, reason: 'invalid', message: NAME_TOO_LONG }, 'tag', chatDeps);
    expect(lines).toEqual(['[chats] tag invalid: A session name must be 1 to 200 characters.']);
    expect(toasts).toEqual([el.render(NAME_TOO_LONG)]);
  });

  it('shows no toast and logs nothing for a leased chat, whose refusal core already showed', () => {
    const { chatDeps, lines, toasts, missing } = deps();
    expect(chatMutationResult({ ok: false, reason: 'leased' }, 'delete', chatDeps)).toEqual({ ok: false, reason: 'leased' });
    expect(lines).toEqual([]);
    expect(toasts).toEqual([]);
    expect(missing).not.toHaveBeenCalled();
  });

  it('answers a missing chat with the missing-chat notice alone, and a success with nothing', () => {
    const { chatDeps, lines, toasts, missing } = deps();
    expect(chatMutationResult({ ok: false, reason: 'missing' }, 'delete', chatDeps)).toEqual({ ok: false, reason: 'missing' });
    expect(missing).toHaveBeenCalledOnce();
    expect(chatMutationResult({ ok: true }, 'delete', chatDeps)).toEqual({ ok: true });
    expect(lines).toEqual([]);
    expect(toasts).toEqual([]);
  });
});
