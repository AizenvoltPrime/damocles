import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { psQuote } from '../quote';
import { powerShell, runPowerShell, scratchDir, stageMessages, withWindowsDefinitions } from './shells';

const BODY = Buffer.alloc(256 * 1024, 0x5a);

interface Request {
  readonly at: number;
  readonly range: string | undefined;
  // the staged file's size when the request arrived, -1 when absent
  readonly stagedBytes: number;
}

type Answer = (res: ServerResponse) => void;

const serve: Answer = (res) => {
  res.writeHead(200, { 'content-length': BODY.length });
  res.end(BODY);
};
const status = (code: number): Answer => (res) => {
  res.writeHead(code);
  res.end();
};
// headers for the whole body, half of it, then a reset
const cutHalfway: Answer = (res) => {
  res.writeHead(200, { 'content-length': BODY.length });
  res.write(BODY.subarray(0, BODY.length / 2), () => res.socket?.destroy());
};

describe('Windows stage 1 download retries under a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = await powerShell();
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }));
  });

  // Serves the answers in order, the last one for every later request.
  const download = async (answers: readonly Answer[]) => {
    const file = path.join(scratchDir('stage-download-'), 'package.zip');
    const requests: Request[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ at: Date.now(), range: req.headers.range, stagedBytes: existsSync(file) ? statSync(file).size : -1 });
      answers[Math.min(requests.length, answers.length) - 1]!(res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/damocles-server.zip`;
    const output = await runPowerShell(shell!, withWindowsDefinitions(`if (Invoke-DamoclesDownload ${psQuote(url)} ${psQuote(file)} ${BODY.length}) { exit 0 } else { exit 3 }`));
    const failures = stageMessages(output).filter((message) => message.kind === 'downloadFailed');
    return { exit: output.exit?.code, failures, requests, file };
  };

  const gaps = (requests: readonly Request[]): number[] => requests.slice(1).map((request, index) => request.at - requests[index]!.at);

  it.skipIf(shell === undefined)('retries a cut transfer and a 503 after 1 s then 2 s, each into a new file, and keeps the third try', async () => {
    const { exit, failures, requests, file } = await download([cutHalfway, status(503), serve]);
    expect(exit).toBe(0);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.range)).toEqual([undefined, undefined, undefined]);
    // the half body of the cut try never survives into a later one
    for (const request of requests.slice(1)) expect(request.stagedBytes).toBeLessThanOrEqual(0);
    const [first, second] = gaps(requests);
    expect(first).toBeGreaterThanOrEqual(1000);
    expect(second).toBeGreaterThanOrEqual(2000);
    // .NET does not pin a cut transfer's WebException status across runtimes and platforms; it is never an HTTP code
    expect(failures).toEqual([
      { kind: 'downloadFailed', attempt: 1, reason: expect.stringMatching(/^(?!http)[a-z][A-Za-z]*$/) },
      { kind: 'downloadFailed', attempt: 2, reason: 'http503' },
    ]);
    expect(readFileSync(file).equals(BODY)).toBe(true);
  });

  it.skipIf(shell === undefined)('gives up after three retries, 1, 2 and 4 s apart, logging each failed try', async () => {
    const { exit, failures, requests } = await download([status(503)]);
    expect(exit).toBe(3);
    expect(requests).toHaveLength(4);
    const [first, second, third] = gaps(requests);
    expect(first).toBeGreaterThanOrEqual(1000);
    expect(second).toBeGreaterThanOrEqual(2000);
    expect(third).toBeGreaterThanOrEqual(4000);
    expect(failures).toEqual([1, 2, 3, 4].map((attempt) => ({ kind: 'downloadFailed', attempt, reason: 'http503' })));
  });

  it.skipIf(shell === undefined)('does not retry an HTTP 404, which no retry changes, and retries a 429', async () => {
    const missing = await download([status(404)]);
    expect(missing.exit).toBe(3);
    expect(missing.requests).toHaveLength(1);
    expect(missing.failures).toEqual([{ kind: 'downloadFailed', attempt: 1, reason: 'http404' }]);
    const limited = await download([status(429), serve]);
    expect(limited.exit).toBe(0);
    expect(limited.requests).toHaveLength(2);
    expect(limited.failures).toEqual([{ kind: 'downloadFailed', attempt: 1, reason: 'http429' }]);
  });
});
