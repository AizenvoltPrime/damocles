import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, nextChat } from '../../desktop/support/fixtures';
import { seedStubModel, type HermeticHome } from '../../desktop/support/hermetic';
import { startOpenAIStub, STUB_MODEL_ID, type OpenAIStub } from '../../desktop/support/openai-stub';
import { shellPage, shellState } from '../../desktop/support/shell';
import { chatInput, clickMenu } from '../../desktop/support/ui';
import { expect } from './remote';
import { containerReachableAddress, HOST_FROM_CONTAINER, TARGET_USER, type SshdFixture } from './sshd';

/**
 * The model stub as pi's `openai` provider: the target account's agent dir lists the provider with no key, and unless
 * `clientCredential` is false this computer holds its key, which the token broker supplies, and selects its model. It listens
 * where the container reaches it.
 */
export async function startTargetStub(home: HermeticHome, fixture: Pick<SshdFixture, 'sh'>, user: 'dev' | 'deploy' = TARGET_USER, clientCredential = true): Promise<OpenAIStub> {
  const stub = await startOpenAIStub({ listenAddress: await containerReachableAddress(), hostName: HOST_FROM_CONTAINER });
  if (clientCredential) seedStubModel(home, stub.baseUrl);
  const models = {
    providers: {
      openai: {
        baseUrl: stub.baseUrl,
        api: 'openai-completions',
        models: [{ id: STUB_MODEL_ID, name: 'Stub model', reasoning: false, input: ['text'], contextWindow: 272000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  };
  const agentDir = `/home/${user}/.damocles/pi/agent`;
  await fixture.sh(`mkdir -p ${agentDir} && cat > ${agentDir}/models.json`, user, JSON.stringify(models, null, 2));
  return stub;
}

/** Selects the project and starts a new chat there; resolves with its page once its composer shows. */
export async function newRemoteChat(app: ElectronApplication, projectKey: string): Promise<Page> {
  const known = [await activeChat(app), ...app.windows()];
  const shell = await shellPage(app);
  await shell.evaluate((key) => window.damoclesShell!.selectProject(key), projectKey);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(projectKey);
  await clickMenu(app, 'damocles.newChat');
  const tab = await nextChat(app, known);
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}
