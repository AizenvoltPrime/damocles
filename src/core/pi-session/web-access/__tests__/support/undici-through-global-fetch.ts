import { isIP } from 'node:net';

// undici for tests that stub the global fetch: its fetch runs the SSRF guard's own lookup on the URL's name, as the guard's
// socket would at connect time, then lets the stubbed global fetch answer in place of the connection.
export function undiciThroughGlobalFetch(actual: typeof import('undici')): typeof import('undici') {
  const fetch = async (input: string, init?: object): Promise<Response> => {
    const { guardedLookup } = await import('../../safe-fetch');
    const host = new URL(input).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) === 0) await new Promise<void>((resolve, reject) => guardedLookup()(host, { all: true }, (err) => (err ? reject(err) : resolve())));
    return globalThis.fetch(input, init as RequestInit);
  };
  return { ...actual, fetch: fetch as unknown as typeof actual.fetch };
}
