import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFakePlatform, installFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { asClient } from '../../client-snapshots';
import { installPlatform } from '../../platform-host';
import { PiRuntime } from '../pi-runtime';
import { MODEL_PICKER_SETTING, MODEL_VENDORS } from '../../../shared/model-vendor';
import type { HeldAuthEntry } from '../../../shared/remote-user';

// configured: pi's availability snapshot, on a daemon's core the host's own credentials; adopted as init adopts pi's
function runtimeWith(configured: string[]): PiRuntime {
  const runtime = PiRuntime.get();
  const modelRuntime = {
    hasConfiguredAuth: (provider: string) => configured.includes(provider),
    isUsingOAuth: () => false,
    getProviderAuthStatus: (provider: string) => (configured.includes(provider) ? { configured: true, source: 'environment' } : { configured: false }),
    getProviders: () => [],
    // every provider takes a sign-in and a key
    getProvider: (id: string) => ({ id, auth: { oauth: {}, apiKey: {} } }),
    getAvailableSnapshot: () => [],
    getAvailable: async () => [],
  };
  (runtime as unknown as { _adoptModelRuntime: (modelRuntime: unknown) => void })._adoptModelRuntime(modelRuntime);
  return runtime;
}

afterEach(async () => {
  await PiRuntime.disposeInstance();
  installPlatform(createFakePlatform());
});

describe('PiRuntime.pickerProviders', () => {
  it('is undefined before the model runtime exists', () => {
    installFakePlatform();
    expect(PiRuntime.get().pickerProviders()).toBeUndefined();
  });

  it('shows each vendor with a credential when the setting names none, in catalog order', () => {
    installFakePlatform();
    expect(runtimeWith(['deepseek', 'anthropic', 'openrouter']).pickerProviders()).toEqual(['anthropic', 'deepseek']);
  });

  it('follows an explicit value over the credential, either way', () => {
    installFakePlatform({ settings: { user: { [MODEL_PICKER_SETTING]: { anthropic: false, xai: true } } } });
    expect(runtimeWith(['anthropic', 'minimax']).pickerProviders()).toEqual(['minimax', 'xai']);
  });

  it('ignores a value that is not a switch', () => {
    installFakePlatform({ settings: { user: { [MODEL_PICKER_SETTING]: { anthropic: 'no', stepfun: 1 } } } });
    expect(runtimeWith(['anthropic']).pickerProviders()).toEqual(['anthropic']);
  });

  it('counts a Codex sign-in or an OpenAI credential for OpenAI', () => {
    installFakePlatform();
    expect(runtimeWith(['openai-codex']).pickerProviders()).toEqual(['openai']);
    expect(runtimeWith(['openai']).pickerProviders()).toEqual(['openai']);
  });

  it('on a daemon\'s core follows the pinned client\'s auth, and never lists another client\'s credential', () => {
    const host = createFakeRemoteHost();
    installPlatform({ ...createFakePlatform({ settings: { user: { [MODEL_PICKER_SETTING]: { xai: true } } } }), remote: host.remote });
    const entry = (type: HeldAuthEntry['type'], hasKey: boolean): HeldAuthEntry => ({ type, hasKey, flatFee: false });
    host.set('clientAuth', 'client-a', { providers: { anthropic: entry('oauth', false), deepseek: entry('none', true), stepfun: entry('none', false) } });
    host.set('clientAuth', 'client-b', { providers: { 'openai-codex': entry('oauth', false) } });
    // the target holds none of its own
    const runtime = runtimeWith([]);
    host.setActing('client-a');
    expect(runtime.pickerProviders()).toEqual(['anthropic', 'deepseek', 'xai']);
    // client b's view, read under b's pin while a still acts
    expect(asClient(host.remote, 'client-b', () => runtime.pickerProviders())).toEqual(['openai', 'xai']);
  });

  it('on a daemon\'s core lists a vendor the target\'s own environment holds a credential for, which the client lacks', () => {
    const host = createFakeRemoteHost();
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'oauth', hasKey: false, flatFee: false } } });
    host.set('clientAuth', 'client-b', {
      providers: { anthropic: { type: 'oauth', hasKey: false, flatFee: false } },
    });
    host.setActing('client-a');
    // the target's own OPENAI_API_KEY
    const runtime = runtimeWith(['openai']);
    expect(runtime.pickerProviders()).toEqual(['anthropic', 'openai']);
    expect(asClient(host.remote, 'client-b', () => runtime.pickerProviders())).toEqual(['anthropic', 'openai']);
  });
});

describe('the model picker setting contribution', () => {
  it('has one switch per catalog vendor, application scope and an empty default', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { scope?: string; default?: unknown; additionalProperties?: unknown; properties?: Record<string, { type?: string }> }> } };
    };
    const setting = pkg.contributes.configuration.properties[MODEL_PICKER_SETTING]!;
    expect(Object.keys(setting.properties ?? {})).toEqual([...MODEL_VENDORS]);
    expect(Object.values(setting.properties ?? {}).every((property) => property.type === 'boolean')).toBe(true);
    expect(setting).toMatchObject({ scope: 'application', default: {}, additionalProperties: false });
  });
});
