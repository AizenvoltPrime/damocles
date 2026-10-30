import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { REPO_ROOT } from '../../../__mocks__/source-tree';
import type { VoiceService } from '../../../core/voice/service';
import { createVoiceStatusBarItem } from '../status-bar';

const GREEK = JSON.parse(readFileSync(path.join(REPO_ROOT, 'l10n', 'bundle.l10n.el.json'), 'utf8')) as Record<string, string>;

afterEach(() => {
  vscode.__setL10nBundle(undefined);
  vscode.__setLanguage('en');
});

describe('the voice status bar item in a Greek VS Code', () => {
  it('words its loading text and its whole error tooltip in Greek', () => {
    vscode.__setL10nBundle(GREEK);
    vscode.__setLanguage('el');
    const voice = new EventEmitter();
    const settings = createFakePlatform({ settings: { user: { 'damocles.voice.mode': 'wake-word' } } }).settings;
    const bar = createVoiceStatusBarItem({ subscriptions: [] } as unknown as vscode.ExtensionContext, voice as unknown as VoiceService, settings);

    voice.emit('status', { kind: 'loading', message: { message: 'Voice runtime not configured' } });
    expect([bar.item.text, bar.item.tooltip]).toEqual(['$(loading~spin) Φόρτωση φωνής', GREEK['Voice runtime not configured']]);

    voice.emit('status', { kind: 'error', code: 'fatal', message: { message: 'Voice runtime not configured' } });
    expect(bar.item.tooltip).toBe(`Σφάλμα φωνής: ${GREEK['Voice runtime not configured']}`);
    bar.dispose();
  });

  it('words every other state, its tooltip included, in Greek', () => {
    vscode.__setL10nBundle(GREEK);
    vscode.__setLanguage('el');
    const voice = new EventEmitter();
    const settings = createFakePlatform({ settings: { user: { 'damocles.voice.mode': 'wake-word' } } }).settings;
    const bar = createVoiceStatusBarItem({ subscriptions: [] } as unknown as vscode.ExtensionContext, voice as unknown as VoiceService, settings);
    const shown = (): [string, unknown] => [bar.item.text, bar.item.tooltip];

    expect(shown()).toEqual(['$(circle-slash) Φωνή ανενεργή', 'Η φωνητική λειτουργία του Damocles έχει σταματήσει']);
    voice.emit('status', { kind: 'restarting', attempt: 2 });
    expect(shown()).toEqual(['$(sync~spin) Επανεκκίνηση φωνής', 'Προσπάθεια επανεκκίνησης 2']);
    voice.emit('status', { kind: 'error', code: 'fatal', message: { message: 'Voice runtime not configured' } });
    expect(bar.item.text).toBe('$(error) Σφάλμα φωνής');
    voice.emit('status', { kind: 'ready', device: 'cuda', vramMbFree: 0, modelsLoaded: [], cpuFallbackActive: false });
    expect(shown()).toEqual(['$(mic-filled) Ακρόαση', 'Το Damocles ακούει για τη λέξη αφύπνισης. Κάντε κλικ για σίγαση.']);
    voice.emit('status', { kind: 'ready', device: 'cpu', vramMbFree: 0, modelsLoaded: [], cpuFallbackActive: true });
    expect(shown()).toEqual(['$(mic-filled) Ακρόαση (CPU)', 'Το Damocles ακούει για τη λέξη αφύπνισης στη CPU. Κάντε κλικ για σίγαση.']);
    voice.emit('message', { type: 'wake_detected' });
    expect(shown()).toEqual(['$(circle-filled) Εγγραφή', 'Εντοπίστηκε η λέξη αφύπνισης, γίνεται εγγραφή']);
    voice.emit('status', { kind: 'cpu-fallback', reason: 'cuda-oom-fallback' });
    expect(shown()).toEqual(['$(mic)', 'Φωνή Damocles']);
    bar.setMuted(true);
    expect(shown()).toEqual(['$(mic) Σίγαση', 'Η φωνή του Damocles είναι σε σίγαση. Κάντε κλικ για κατάργηση της σίγασης.']);
    bar.dispose();
  });
});
