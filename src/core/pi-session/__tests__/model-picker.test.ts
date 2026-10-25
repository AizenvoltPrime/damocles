import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFakePlatform, installFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { PiRuntime } from '../pi-runtime';
import { MODEL_PICKER_SETTING, MODEL_VENDORS } from '../../../shared/model-vendor';
import type { HeldAuthEntry } from '../../../shared/remote-user';

function runtimeWith(configured: string[]): PiRuntime {
  const runtime = PiRuntime.get();
  (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = { hasConfiguredAuth: (provider: string) => configured.includes(provider) };
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

  it('on a daemon\'s core follows the acting client\'s auth, not pi\'s snapshot', () => {
    const host = createFakeRemoteHost();
    installPlatform({ ...createFakePlatform({ settings: { user: { [MODEL_PICKER_SETTING]: { xai: true } } } }), remote: host.remote });
    const entry = (type: HeldAuthEntry['type'], hasKey: boolean): HeldAuthEntry => ({ type, hasKey, flatFee: false });
    host.set('clientAuth', 'client-a', { providers: { anthropic: entry('oauth', false), deepseek: entry('none', true), stepfun: entry('none', false) } });
    host.set('clientAuth', 'client-b', { providers: { 'openai-codex': entry('oauth', false) } });
    const runtime = runtimeWith([...MODEL_VENDORS]);
    expect(runtime.pickerProviders()).toEqual(['anthropic', 'deepseek', 'xai']);
    host.setActing('client-b');
    expect(runtime.pickerProviders()).toEqual(['openai', 'xai']);
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
