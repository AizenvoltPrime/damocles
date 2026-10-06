import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '../support/fixtures';
import { seedStubModel, writeUserSettings } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { THEMES, openProjectChat, saveScreenshot, settled, showTheme } from '../support/screenshots';
import { chatInput } from '../support/ui';

// Review capture of the dock naming the team agent whose shell command waits for approval.

test('dock attribution for a team agent', async ({ home, launch }, testInfo) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.team.enabled': true });
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'npm test -- --grep lockout' } }] },
    );
    await chatInput(tab).fill('Lock an account after ten failed logins');
    await chatInput(tab).press('Enter');

    const prompt = tab.getByTestId('permission-card');
    await expect(prompt).toContainText('Atlas from team Lockout wants to run this command:');
    await showTheme(app, tab, 'dark');
    await settled(tab);
    await saveScreenshot(tab, testInfo, 'team-agent-permission-dock', prompt);
  } finally {
    await stub.close();
  }
});

// Review captures of a team agent waiting on the user, and of the options a shell and an edit prompt offer.

test('team card with an agent waiting, and the shell prompt it waits on', async ({ home, launch }, testInfo) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.team.enabled': true });
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    // The breathing mark holds still, so each capture shows it at full strength.
    await tab.emulateMedia({ reducedMotion: 'reduce' });

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'npm test -- --grep lockout' } }] },
    );
    await chatInput(tab).fill('Lock an account after ten failed logins');
    await chatInput(tab).press('Enter');

    const prompt = tab.getByTestId('permission-card');
    const teamCard = tab.getByTestId('team-card');
    await expect(teamCard.getByTestId('team-status')).toHaveText('Needs you');
    for (const theme of THEMES) {
      await showTheme(app, tab, theme);
      await settled(tab);
      await saveScreenshot(tab, testInfo, `team-card-waiting-${theme}`, teamCard);
      await saveScreenshot(tab, testInfo, `shell-prompt-options-${theme}`, prompt);
    }
  } finally {
    await stub.close();
  }
});

test('edit prompt options', async ({ home, launch }, testInfo) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'lockout.ts');
    fs.writeFileSync(file, 'export const MAX_ATTEMPTS = 5;\n');
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'MAX_ATTEMPTS = 5', new_string: 'MAX_ATTEMPTS = 10' } }] });
    await chatInput(tab).fill('Allow ten attempts');
    await chatInput(tab).press('Enter');

    const prompt = tab.getByTestId('permission-card');
    await expect(prompt.getByRole('option', { name: 'Yes, and accept all edits this session' })).toBeVisible();
    for (const theme of THEMES) {
      await showTheme(app, tab, theme);
      await settled(tab);
      await saveScreenshot(tab, testInfo, `edit-prompt-options-${theme}`, prompt);
    }
  } finally {
    await stub.close();
  }
});
