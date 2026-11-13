import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import { call, lastToolResultRequest, type OpenAIStub } from './openai-stub';
import { awaitTurnEnd, chatInput } from './ui';

/**
 * A turn whose one tool call is the agent's bash running `command`, approved when the chat's mode asks; resolves with the
 * body of the last request that carried a tool result to the model, once the turn ended.
 */
export async function agentBash(tab: Page, openai: OpenAIStub, command: string, prompt: string): Promise<string> {
  openai.replies.push(call('bash', { command }));
  await chatInput(tab).fill(prompt);
  await chatInput(tab).press('Enter');
  const permission = tab.getByRole('region', { name: 'Permission request' });
  const echo = tab.getByText(`Echo: ${prompt}`, { exact: true });
  await expect(permission.or(echo)).toBeVisible({ timeout: 60_000 });
  if (await permission.isVisible()) await permission.getByRole('option', { name: 'Yes', exact: true }).click();
  await expect(echo).toBeVisible({ timeout: 60_000 });
  await awaitTurnEnd(tab);
  return lastToolResultRequest(openai);
}
