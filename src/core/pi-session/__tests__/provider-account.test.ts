import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { InMemoryModelsStore, type Api, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { accountFailureOf, failureCard, failureText } from '../provider-account';
import { nestedCallError, nestedCallFailure, nestedRunError } from '../nested-call-failures';
import { customProviderDef } from '../custom-providers';
import { loadFormatNoApiKeyFoundMessage } from '../../../__mocks__/pi-auth-guidance';
import { inGreek } from '../../../__mocks__/greek-locale';
import { englishText, type LocalizedText } from '../../../shared/localized-text';

let formatNoApiKeyFoundMessage: (provider: string) => string;
beforeAll(async () => {
  formatNoApiKeyFoundMessage = await loadFormatNoApiKeyFoundMessage();
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function runtime(): Promise<ModelRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-provider-account-'));
  dirs.push(dir);
  return ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
}

/** What pi records as the failed call's `errorMessage` when it streams `model` now. */
async function callError(models: ModelRuntime, model: Model<Api>): Promise<string | undefined> {
  const reply = await models.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, {}).result();
  return reply.errorMessage;
}

/** What pi records for a call on `provider` whose server answers `status` with `body`, read by pi-ai and the provider's own SDK. */
async function answeredError(provider: string, status: number, body: unknown): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const models = await runtime();
    await models.setRuntimeApiKey(provider, 'sk-test');
    const model = models.getModels().find((m) => m.provider === provider)!;
    const message = await callError(models, { ...model, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    expect(message).toBeDefined();
    return message!;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * The `compaction_end` error texts and the rethrown error of a real pi session that compacts on `model` once its
 * credential is gone: manual, threshold and overflow.
 */
async function compactionFailures(models: ModelRuntime, model: Model<Api>, removeCredential: () => Promise<void>): Promise<{ ended: string[]; thrown: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-provider-account-session-'));
  dirs.push(dir);
  const sessionManager = SessionManager.inMemory(dir);
  const assistant = (text: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  });
  for (const turn of ['first', 'second']) {
    sessionManager.appendMessage({ role: 'user', content: `the ${turn} question`, timestamp: Date.now() });
    sessionManager.appendMessage(assistant(`the ${turn} answer`));
  }
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: models,
    model,
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } }),
    noTools: 'all',
  });
  const ended: string[] = [];
  session.subscribe((event) => {
    if (event.type === 'compaction_end' && event.errorMessage) ended.push(event.errorMessage);
  });
  await removeCredential();
  let thrown = '';
  try {
    await session.compact();
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  const auto = session as unknown as { _runAutoCompaction: (reason: 'threshold' | 'overflow', willRetry: boolean) => Promise<boolean> };
  await auto._runAutoCompaction('threshold', false);
  await auto._runAutoCompaction('overflow', false);
  session.dispose();
  return { ended, thrown };
}

describe('accountFailureOf, a failed compaction in pi\'s wrappers', () => {
  it('reads a compaction whose key was removed as no saved credential, manual, threshold and overflow', async () => {
    const models = await runtime();
    await models.setRuntimeApiKey('deepseek', 'sk-test');
    const model = models.getModels().find((m) => m.provider === 'deepseek')!;

    const { ended, thrown } = await compactionFailures(models, model, () => models.removeRuntimeApiKey('deepseek'));

    expect(ended.map((message) => message.slice(0, message.indexOf(':')))).toEqual(['Compaction failed', 'Auto-compaction failed', 'Context overflow recovery failed']);
    for (const message of [...ended, thrown]) {
      expect(message).toContain('Provider is not configured: deepseek');
      expect(accountFailureOf('deepseek', message)).toEqual({ account: 'deepseek', reason: 'missing' });
    }
  }, 30_000);

  it('names a provider with no Accounts row when its compaction lost the credential', async () => {
    const models = await runtime();
    await models.setRuntimeApiKey('cerebras', 'sk-test');
    const model = models.getModels().find((m) => m.provider === 'cerebras')!;

    const { ended, thrown } = await compactionFailures(models, model, () => models.removeRuntimeApiKey('cerebras'));

    expect(ended).toHaveLength(3);
    for (const message of [...ended, thrown]) {
      expect(failureCard('cerebras', model.id, message)).toEqual({ type: 'error', message: { message: 'No credential is set up for {0}, so {1} could not run. Pick a model from a provider you are signed in to.', args: ['cerebras', model.id] } });
    }
  }, 30_000);

  it('reads pi\'s "No API key found" inside its wrappers as no saved credential, though its login help mentions OAuth', () => {
    for (const wrapped of [`Compaction failed: ${formatNoApiKeyFoundMessage('deepseek')}`, `Auto-compaction failed: Summarization failed: ${formatNoApiKeyFoundMessage('deepseek')}`]) {
      expect(accountFailureOf('deepseek', wrapped)).toEqual({ account: 'deepseek', reason: 'missing' });
    }
  });

  it('reads xAI\'s 402 inside the wrappers as no API access, from its status', () => {
    expect(accountFailureOf('xai', 'Compaction failed: Summarization failed: xAI (402): {"error":"no credits"}')).toEqual({ account: 'xai', reason: 'noApiAccess' });
  });

  it('keeps the wrappers anchored: a wrapper inside other text is not stripped', () => {
    expect(accountFailureOf('deepseek', 'note: Compaction failed: Provider is not configured: deepseek')).toBeUndefined();
    expect(accountFailureOf('deepseek', 'Summarization failed: Compaction failed: Provider is not configured: deepseek')).toBeUndefined();
  });
});

describe('accountFailureOf, a credential the provider refused', () => {
  // Each provider's own 401 body; OpenAI's and OpenRouter's name no auth word, so only the status classifies them.
  it.each([
    ['anthropic', { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }],
    ['openai', { error: { message: 'Incorrect API key provided: sk-test.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }],
    ['openrouter', { error: { message: 'No auth credentials found', code: 401 } }],
  ])('reads a 401 from %s, in the shape pi records it, as the credential refused', async (provider, body) => {
    const message = await answeredError(provider, 401, body);

    expect(accountFailureOf(provider, message)?.reason).toBe('rejected');
    expect(accountFailureOf(provider, `Compaction failed: Summarization failed: ${message}`)?.reason).toBe('rejected');
  });

  it('reads a failure whose body has 401 inside a number as no credential failure', async () => {
    const message = await answeredError('anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 240115 tokens > 200000 maximum' } });

    expect(message).toContain('240115');
    expect(accountFailureOf('anthropic', message)).toBeUndefined();
    expect(accountFailureOf('anthropic', `Compaction failed: Summarization failed: ${message}`)).toBeUndefined();
  });

  it("reads pi's own OAuth failures as the credential refused", () => {
    expect(accountFailureOf('github-copilot', 'OAuth auth derivation failed for github-copilot')?.reason).toBe('rejected');
    expect(accountFailureOf('anthropic', 'OAuth refresh failed for anthropic: 400 invalid_grant')?.reason).toBe('rejected');
  });
});

describe('accountFailureOf, a missing credential in pi\'s own words', () => {
  it('reads pi\'s "No API key found" refusal of a prompt as no saved credential, though its login help mentions OAuth', () => {
    const message = formatNoApiKeyFoundMessage('deepseek');
    expect(message).toContain('/login');
    expect(accountFailureOf('deepseek', message)).toEqual({ account: 'deepseek', reason: 'missing' });
    expect(accountFailureOf('anthropic', formatNoApiKeyFoundMessage('anthropic'))).toEqual({ account: 'anthropic', reason: 'missing' });
    expect(accountFailureOf('openai-codex', formatNoApiKeyFoundMessage('openai-codex'))).toEqual({ account: 'openai', reason: 'missing' });
  });

  it('reads a model call whose key was removed since the run began as no saved credential', async () => {
    const models = await runtime();
    await models.setRuntimeApiKey('deepseek', 'sk-test');
    const model = models.getModels().find((m) => m.provider === 'deepseek')!;
    await models.removeRuntimeApiKey('deepseek');

    const message = await callError(models, model);
    expect(accountFailureOf('deepseek', message!)).toEqual({ account: 'deepseek', reason: 'missing' });
    expect(failureCard('deepseek', model.id, message!)).toEqual({ type: 'authFailure', message, account: 'deepseek', reason: 'missing' });
  });

  it('reads a call on StepFun, which Damocles unregisters when its key is cleared, as no saved credential', async () => {
    const models = await runtime();
    models.registerProvider('stepfun', { ...customProviderDef('stepfun').key.registerConfig!, apiKey: 'sk-test' });
    const model = models.getModels().find((m) => m.provider === 'stepfun')!;
    models.unregisterProvider('stepfun');

    expect(accountFailureOf('stepfun', (await callError(models, model))!)).toEqual({ account: 'stepfun', reason: 'missing' });
  });

  it('names a provider with no Accounts row and its model in Damocles\' words, never pi\'s login help or install paths', async () => {
    const models = await runtime();
    await models.setRuntimeApiKey('cerebras', 'sk-test');
    const model = models.getModels().find((m) => m.provider === 'cerebras')!;
    await models.removeRuntimeApiKey('cerebras');
    const callFailure = (await callError(models, model))!;
    const words = `No credential is set up for cerebras, so ${model.id} could not run. Pick a model from a provider you are signed in to.`;

    for (const message of [formatNoApiKeyFoundMessage('cerebras'), callFailure]) {
      expect(accountFailureOf('cerebras', message)).toBeUndefined();
      const card = failureCard('cerebras', model.id, message);
      expect(card.type).toBe('error');
      expect(englishText(card.message as LocalizedText)).toBe(words);
      expect(englishText(failureText('cerebras', model.id, message))).toBe(words);
    }
    expect(failureCard('cerebras', model.id, 'cerebras API error (500): overloaded')).toEqual({ type: 'error', message: { message: '{0}', args: ['cerebras API error (500): overloaded'] } });
  });

  it('gives a transcript with no account card a provider-named text for a row\'s missing credential', () => {
    expect(englishText(failureText('deepseek', 'deepseek-v4-pro', formatNoApiKeyFoundMessage('deepseek')))).toBe('No DeepSeek credential is saved, so DeepSeek V4 Pro could not run. Add an API key in Settings › Models & accounts.');
    expect(englishText(nestedCallFailure({ errorMessage: 'Provider is not configured: deepseek', provider: 'deepseek', model: 'deepseek-v4-pro' }))).toBe('No DeepSeek credential is saved, so DeepSeek V4 Pro could not run. Add an API key in Settings › Models & accounts.');
    expect(nestedCallFailure({ errorMessage: 'Anthropic (529): overloaded', provider: 'anthropic', model: 'claude-sonnet-5-5' })).toEqual({ message: '{0}', args: ['Anthropic (529): overloaded'] });
  });

  // What a row takes comes from the account facts: a key, a sign-in, or either.
  it('tells the user what the row takes: a key, a sign-in, or either', () => {
    const text = (provider: string, model: string) => englishText(failureText(provider, model, `Provider is not configured: ${provider}`));

    expect(text('minimax', 'MiniMax-M3')).toMatch(/could not run\. Add an API key in Settings › Models & accounts\.$/);
    expect(text('github-copilot', 'claude-opus-5.5')).toBe('No GitHub Copilot credential is saved, so Opus 5.5 could not run. Sign in to GitHub Copilot in Settings › Models & accounts.');
    for (const [provider, model, words] of [
      ['anthropic', 'claude-sonnet-5-5', 'No Anthropic credential is saved, so Sonnet 5.5'],
      ['openai-codex', 'gpt-6.1-sol', 'No OpenAI credential is saved, so'],
      ['xai', 'grok-5', 'No xAI credential is saved, so'],
    ] as const) {
      expect(text(provider, model)).toMatch(new RegExp(`^${words}.* could not run\\. Sign in or add an API key in Settings › Models & accounts\\.$`));
    }
  });

  // Text the model reads is English; the transcript's card is text each view renders in its own language.
  it('gives the model English and the transcript text a Greek view renders in Greek, from one text', () => {
    const refused = { errorMessage: 'Provider is not configured: anthropic', provider: 'anthropic', model: 'claude-sonnet-5-5' };
    const english = 'No Anthropic credential is saved, so Sonnet 5.5 could not run. Sign in or add an API key in Settings › Models & accounts.';

    expect(nestedCallError(refused)).toBe(english);
    expect(nestedRunError({ model: { provider: 'anthropic', id: 'claude-sonnet-5-5' } } as never, new Error(formatNoApiKeyFoundMessage('anthropic')))).toBe(english);
    expect(englishText(nestedCallFailure(refused))).toBe(english);
    expect(inGreek(nestedCallFailure(refused))).toBe('Δεν υπάρχει αποθηκευμένο διαπιστευτήριο για το Anthropic, οπότε το Sonnet 5.5 δεν μπόρεσε να εκτελεστεί. Συνδεθείτε ή προσθέστε ένα κλειδί API στις Ρυθμίσεις › Μοντέλα και λογαριασμοί.');
    expect(inGreek(failureCard('cerebras', 'gpt-oss-120b', 'Provider is not configured: cerebras').message as LocalizedText)).toBe('Δεν έχει ρυθμιστεί διαπιστευτήριο για το cerebras, οπότε το gpt-oss-120b δεν μπόρεσε να εκτελεστεί. Επιλέξτε ένα μοντέλο από έναν πάροχο στον οποίο έχετε συνδεθεί.');
  });

  it('matches only the exact shapes, naming the run\'s own provider', () => {
    expect(accountFailureOf('deepseek', formatNoApiKeyFoundMessage('minimax'))?.reason).not.toBe('missing');
    expect(accountFailureOf('deepseek', `${formatNoApiKeyFoundMessage('deepseek')}\nmore`)?.reason).not.toBe('missing');
    expect(accountFailureOf('deepseek', 'Provider is not configured: minimax')).toBeUndefined();
    expect(accountFailureOf('deepseek', 'deepseek API error (400): Provider is not configured: deepseek')).toBeUndefined();
    expect(accountFailureOf('deepseek', 'Unknown provider: deepseekx')).toBeUndefined();
  });
});
