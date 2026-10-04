import { expect, test } from './support/fixtures';
import { hostMessage, openProjectChat } from './support/screenshots';
import { chatInput } from './support/ui';

const question = (toolUseId: string): Record<string, unknown> => ({
  type: 'requestQuestion',
  toolUseId,
  questions: [{ header: 'Store', question: 'Where should the limiter keep its counters?', multiSelect: false, options: [{ label: 'In memory', description: '' }, { label: 'Redis', description: '' }] }],
});

// reka's listbox focuses on mount in the real renderer, so the dock prompt focus rule is checked here as well as in happy-dom.
test('a dock prompt takes focus as it appears, but never from the composer the user is typing in', async ({ home, launch }) => {
  test.setTimeout(120_000);
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  const card = tab.getByTestId('question-card');
  const options = card.getByRole('listbox', { name: 'Where should the limiter keep its counters?' });

  await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await hostMessage(app, tab, question('e2e-q1'));
  await expect(options.getByRole('option', { name: /In memory/ })).toBeFocused();
  await tab.keyboard.press('ArrowDown');
  await tab.keyboard.press('Enter');
  await expect(card.getByText('Review your answers')).toBeVisible();
  await expect(card).toContainText('Redis');
  await hostMessage(app, tab, { type: 'sessionCancelled' });
  await expect(card).toBeHidden();

  await chatInput(tab).click();
  await chatInput(tab).pressSequentially('hel');
  await hostMessage(app, tab, question('e2e-q2'));
  await expect(options).toBeVisible();
  await tab.keyboard.type('lo');
  await expect(chatInput(tab)).toBeFocused();
  await expect(chatInput(tab)).toHaveValue('hello');
  await hostMessage(app, tab, { type: 'sessionCancelled' });

  await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await hostMessage(app, tab, { type: 'requestSkillApproval', toolUseId: 'e2e-skill', skillName: 'review-pr' });
  await expect(tab.getByTestId('skill-card').getByRole('listbox', { name: 'Use skill "review-pr"?' }).getByRole('option', { name: /^Yes$/ })).toBeFocused();
});
