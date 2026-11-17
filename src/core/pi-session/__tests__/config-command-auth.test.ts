import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader } from '../pi-loader';
import { installFakePlatform } from '../../../__mocks__/fake-platform';

const COMMAND_MS = 1500;

/** A models.json `!command` value that prints `value` after COMMAND_MS, run by the shell pi picks for it. */
const slowCommand = (value: string): string =>
  `!"${process.execPath.replaceAll('\\', '/')}" -e "setTimeout(() => console.log('${value}'), ${COMMAND_MS})"`;

/** The event-loop turns `task` lets run while it is pending; a command run synchronously allows none. */
async function turnsDuring<T>(task: () => Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0;
  let counting = true;
  const turn = (): void => {
    turns++;
    if (counting) setImmediate(turn);
  };
  setImmediate(turn);
  try {
    return { result: await task(), turns };
  } finally {
    counting = false;
  }
}

/** pi resolves a models.json `!command` key and header when a request asks for its auth, in the engine's thread (patches/README.md, 003). */
describe('a models.json !command credential', () => {
  const made: string[] = [];

  beforeAll(async () => {
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs while the event loop keeps turning', async () => {
    installFakePlatform();
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-command-auth-')));
    made.push(agentDir);
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'slow-key': {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          apiKey: slowCommand('sk-from-command'),
          headers: { 'x-from-command': slowCommand('header-from-command') },
          models: [{ id: 'm', name: 'Own endpoint', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }));
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    const models = runtime.modelRuntime!;
    const model = models.getModel('slow-key', 'm')!;

    const { result, turns } = await turnsDuring(() => models.getAuth(model));

    expect(result?.auth).toMatchObject({ apiKey: 'sk-from-command', headers: { 'x-from-command': 'header-from-command' } });
    expect(turns).toBeGreaterThanOrEqual(100);
  }, 60_000);
});
