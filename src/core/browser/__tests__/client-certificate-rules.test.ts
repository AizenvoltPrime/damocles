import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// no Chromium starts: each launch records the profile's Preferences as Chrome would read them, then fails
const { launched } = vi.hoisted(() => ({ launched: [] as unknown[] }));
vi.mock('../launcher', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  return {
    launchBrowserContext: vi.fn(async (options: { userDataDir: string }) => {
      launched.push(JSON.parse(readFileSync(join(options.userDataDir, 'Default', 'Preferences'), 'utf8')));
      throw new Error('no browser in this test');
    }),
  };
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserService } from '../index';
import { writeClientCertificateRules } from '../client-certificate-rules';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { PanelHost } from '../../../platform/window-service';
import type { ClientCertificateFilter } from '../../../shared/client-certificate';

const FILTER: ClientCertificateFilter = { ISSUER: { CN: 'Corp CA' }, SUBJECT: { CN: 'alice', O: 'Corp' } };
const ruleOf = (preferences: unknown): unknown => (preferences as { profile: { content_settings: { exceptions: { auto_select_certificate: unknown } } } }).profile.content_settings.exceptions.auto_select_certificate;

let profile: string;
let platform: FakePlatform;

beforeEach(() => {
  launched.length = 0;
  profile = mkdtempSync(join(tmpdir(), 'dam-client-cert-'));
  platform = installFakePlatform({ chatBrowserPane: true, settings: { user: { 'damocles.browser.enabled': true } } });
});

afterEach(() => {
  rmSync(profile, { recursive: true, force: true });
});

function preferencesFile(): string {
  return join(profile, 'Default', 'Preferences');
}

function seedPreferences(value: unknown): void {
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(preferencesFile(), JSON.stringify(value));
}

const chat = (): PanelHost => platform.window.createPanel({ kind: 'chat', title: 'chat', localResourceRoots: [] });

describe('writeClientCertificateRules', () => {
  it('replaces the auto-selection key with exactly the rules and keeps every other preference', async () => {
    seedPreferences({
      browser: { has_seen_welcome_page: true },
      profile: { name: 'Person 1', content_settings: { exceptions: { cookies: { 'https://a.test:443,*': { setting: 1 } }, auto_select_certificate: { 'https://old.test:443,*': { setting: { filters: [{ SUBJECT: { CN: 'old' } }] } } } } } },
    });
    await writeClientCertificateRules(profile, new Map([['https://intranet.test:8443', FILTER]]));
    const written = JSON.parse(readFileSync(preferencesFile(), 'utf8'));
    expect(ruleOf(written)).toEqual({ 'https://intranet.test:8443,*': { setting: { filters: [FILTER] } } });
    expect(written.browser).toEqual({ has_seen_welcome_page: true });
    expect(written.profile.name).toBe('Person 1');
    expect(written.profile.content_settings.exceptions.cookies).toEqual({ 'https://a.test:443,*': { setting: 1 } });
  });

  it('makes the Preferences of a profile Chrome never ran', async () => {
    await writeClientCertificateRules(profile, new Map([['https://[::1]:9443', FILTER]]));
    expect(ruleOf(JSON.parse(readFileSync(preferencesFile(), 'utf8')))).toEqual({ 'https://[::1]:9443,*': { setting: { filters: [FILTER] } } });
  });

  it('refuses a filter naming no field, which Chrome would match to any certificate the site is offered', async () => {
    await expect(writeClientCertificateRules(profile, new Map([['https://intranet.test:443', { ISSUER: {}, SUBJECT: {} }]]))).rejects.toThrow('names no field');
    const service = new BrowserService(platform, { profileDir: profile });
    await expect(service.useClientCertificate('https://intranet.test:443', { ISSUER: {}, SUBJECT: {} })).rejects.toThrow('names no field');
    await expect(service.openNewPageForChat(chat())).rejects.toThrow('no browser in this test');
    expect(ruleOf(launched[0])).toEqual({});
  });

  it('refuses an origin that is not the exact https form, and a Preferences file that is not JSON', async () => {
    await expect(writeClientCertificateRules(profile, new Map([['https://[*.]corp.test:443', FILTER]]))).rejects.toThrow('is not an https origin');
    seedPreferences([]);
    await expect(writeClientCertificateRules(profile, new Map())).rejects.toThrow('does not hold a JSON object');
    writeFileSync(preferencesFile(), '{');
    await expect(writeClientCertificateRules(profile, new Map())).rejects.toThrow();
    expect(readFileSync(preferencesFile(), 'utf8')).toBe('{');
  });
});

describe('BrowserService client certificates', () => {
  it('clears a rule another app session left before the first launch, with no rule chosen in this one', async () => {
    seedPreferences({ profile: { content_settings: { exceptions: { auto_select_certificate: { 'https://left.test:443,*': { setting: { filters: [FILTER] } } } } } } });
    const service = new BrowserService(platform, { profileDir: profile });
    await expect(service.openNewPageForChat(chat())).rejects.toThrow('no browser in this test');
    expect(launched).toHaveLength(1);
    expect(ruleOf(launched[0])).toEqual({});
  });

  it('launches with the rules chosen while no browser ran', async () => {
    const service = new BrowserService(platform, { profileDir: profile });
    await service.useClientCertificate('https://intranet.test:443', FILTER);
    await expect(service.openNewPageForChat(chat())).rejects.toThrow('no browser in this test');
    expect(ruleOf(launched[0])).toEqual({ 'https://intranet.test:443,*': { setting: { filters: [FILTER] } } });
  });

  it('writes a rule at once into a profile prepared for a launch that failed', async () => {
    const service = new BrowserService(platform, { profileDir: profile });
    await expect(service.openNewPageForChat(chat())).rejects.toThrow('no browser in this test');
    await service.useClientCertificate('https://intranet.test:443', FILTER);
    expect(ruleOf(JSON.parse(readFileSync(preferencesFile(), 'utf8')))).toEqual({ 'https://intranet.test:443,*': { setting: { filters: [FILTER] } } });
  });

  it('refuses an origin that is not the exact https form and keeps no rule for it', async () => {
    const service = new BrowserService(platform, { profileDir: profile });
    await expect(service.useClientCertificate('https://[*.]corp.test:443', FILTER)).rejects.toThrow('Not an https origin');
    await expect(service.openNewPageForChat(chat())).rejects.toThrow('no browser in this test');
    expect(ruleOf(launched[0])).toEqual({});
  });

  it('closes a running browser and reopens each chat\'s pages where its human scope was', async () => {
    const service = new BrowserService(platform, { profileDir: profile });
    const first = chat();
    const second = chat();
    // each chat's human scope, as its first page registers it
    const priv = service as unknown as {
      context: unknown;
      userDataDir: string | null;
      pages: Map<unknown, unknown>;
      scopes: Map<string, { currentPage: unknown }>;
      humanScopeId(chat: PanelHost): string;
    };
    const close = vi.fn(async () => {});
    priv.context = { close };
    priv.userDataDir = profile;
    const page = (owner: PanelHost, url: string, unreachableUrl: string | null = null) => {
      const key = { url };
      priv.pages.set(key, { page: key, chat: owner, closing: false, lastUrl: url, unreachableUrl, pendingAck: null, ackRestartTimer: null, picker: { stopPicking: async () => {} }, panel: { dispose: vi.fn() } });
      return key;
    };
    page(first, 'https://a.test/');
    const shown = page(first, 'https://b.test/');
    page(second, 'https://ok.test/', 'https://down.test/');
    priv.scopes.get(priv.humanScopeId(first))!.currentPage = shown;
    const restore = vi.spyOn(service, 'restoreChatPages').mockResolvedValue();

    await service.useClientCertificate('https://intranet.test:443', FILTER);

    expect(close).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls).toEqual([
      [first, ['https://a.test/', 'https://b.test/'], 1],
      [second, ['https://down.test/'], undefined],
    ]);
    // the profile is prepared again for the relaunch, so the reopened pages get the rule
    restore.mockRestore();
    await expect(service.openNewPageForChat(chat())).rejects.toThrow('no browser in this test');
    expect(ruleOf(launched.at(-1))).toEqual({ 'https://intranet.test:443,*': { setting: { filters: [FILTER] } } });
  });
});
