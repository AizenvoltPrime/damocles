import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, folderEntry, makeFakeHost, type Harness } from './panel-manager-harness';

function cspOf(html: string): string {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  if (csp === undefined) throw new Error('no CSP meta tag in the panel HTML');
  return csp.replace(/'nonce-[^']+'/, "'nonce-<nonce>'");
}

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe('chat panel CSP worker-src', () => {
  it('appends worker-src only for a host that supplies it', () => {
    harness = createHarness([folderEntry('/ws')]);
    const host = Object.assign(makeFakeHost(), { cspSource: 'app://damocles', workerSrc: 'app://damocles' });

    expect(cspOf(harness.manager.getHtmlContent(host))).toBe(
      "default-src 'none'; style-src app://damocles 'unsafe-inline'; script-src 'nonce-<nonce>' 'wasm-unsafe-eval'; font-src app://damocles; img-src app://damocles data: https:; worker-src app://damocles;",
    );
  });

  it('leaves worker-src out when the host supplies none', () => {
    harness = createHarness([folderEntry('/ws')]);

    expect(cspOf(harness.manager.getHtmlContent(makeFakeHost()))).not.toContain('worker-src');
  });
});
