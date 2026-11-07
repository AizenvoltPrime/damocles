import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ShellDesignPreview, ShellEditorTab } from '../../../src/desktop/preload/shell-channels';
import { windowViews, type ViewInfo } from './browser';
import { editorState } from './editor';
import { REPO_ROOT, type HermeticHome } from './hermetic';
import { call, type OpenAIStub, type StubReply } from './openai-stub';
import { awaitTurnEnd, chatInput } from './ui';

// What the design mode specs share: the fixture app, the design chat a scripted StartDesign opens, and its preview views.

/** The fixture app every design spec copies whole into its project. */
export const DESIGN_APP = path.join(REPO_ROOT, 'e2e', 'fixtures', 'design-app');
export const DESIGN_SCHEME = 'damocles-design:';
// A remote design chat's page opens over the slower wire.
const DESIGN_PAGE_TIMEOUT = 60_000;

/** The fixture app's inventory as the designer reports it. */
export const FIXTURE_INVENTORY = {
  stack: 'Laravel 11, Inertia, Vue 3, Tailwind 4',
  components: [
    { name: 'Button', path: 'resources/js/components/ui/Button.vue' },
    { name: 'Input', path: 'resources/js/components/ui/Input.vue' },
    { name: 'Badge', path: 'resources/js/components/ui/Badge.vue' },
    { name: 'Table', path: 'resources/js/components/ui/Table.vue' },
  ],
  screens: [{ id: 'S1', entry: 'resources/js/pages/Contacts/Index.vue', route: '/contacts', container: 'max-w-7xl' }],
  types: [{ name: 'Contact', path: 'types/contact.ts:1', fields: ['id', 'name', 'email'] }],
};

export type Fidelity = 'Static mockup' | 'Interactive prototype';

/** The designer's first question; a static design needs no journey before FinishDesign (PD-21). */
export const FIDELITY_QUESTION: StubReply = call('AskUserQuestion', {
  questions: [{
    header: 'Fidelity',
    question: 'Static mockup or interactive prototype?',
    options: [{ label: 'Static mockup', description: 'Screens only' }, { label: 'Interactive prototype', description: 'Clickable states' }],
    multiSelect: false,
  }],
});

/** The designer grounding itself in the fixture app, then writing `designMd`. */
export function grounding(folder: string, designMd: string, tokenFiles: readonly string[] = ['resources/css/app.css']): StubReply[] {
  return [
    call('Inventory', FIXTURE_INVENTORY),
    call('ExtractTokens', { files: tokenFiles }),
    call('write', { path: path.join(folder, 'design.md'), content: designMd }),
  ];
}

/** The chat page with a design header that is none of `known`; a design chat opens beside its parent, whichever chat the window selects. */
export async function designChatPage(app: ElectronApplication, known: readonly Page[]): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    for (const page of app.windows()) {
      if (known.includes(page) || page.isClosed() || !page.url().includes('/panel/')) continue;
      if ((await page.getByTestId('design-header').count()) > 0) return (found = page);
    }
    return undefined;
  }, { timeout: DESIGN_PAGE_TIMEOUT }).toBeDefined();
  return found!;
}

/** The one design folder StartDesign created under the home (`.state` is core's). */
export function designFolder(damoclesDir: string): string {
  const root = path.join(damoclesDir, 'designs');
  const folders = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  expect(folders).toHaveLength(1);
  return path.join(root, folders[0]!.name);
}

/** Answers the designer's fidelity question. */
export async function answerFidelity(design: Page, fidelity: Fidelity): Promise<void> {
  const question = design.getByRole('region', { name: 'Question prompt' });
  await question.getByRole('option', { name: fidelity }).click();
  await question.getByRole('button', { name: 'Submit', exact: true }).last().click();
}

// A design whose check ran at every width can take a while to reach FinishDesign's prompt.
const APPROVAL_TIMEOUT = 120_000;

/** The approval prompt a FinishDesign whose check passed raises in the design chat. */
export function designApproval(design: Page): Locator {
  return design.getByRole('region', { name: 'The design is ready for your approval' });
}

/** Approves the design chat's FinishDesign prompt, which makes the version and hands it to the main chat. */
export async function approveDesign(design: Page): Promise<void> {
  const prompt = designApproval(design);
  await expect(prompt).toBeVisible({ timeout: APPROVAL_TIMEOUT });
  await prompt.getByRole('option', { name: /^Approve/ }).click();
  await expect(prompt).toHaveCount(0);
}

export interface DesignChatOptions {
  readonly fidelity: Fidelity;
  /** The designer's run after the fidelity answer, given its design folder. */
  readonly script: (folder: string) => StubReply[];
  /** Where the design folder is; by default the one under the hermetic home. */
  readonly findFolder?: () => Promise<string>;
}

/**
 * The parent's scripted StartDesign opens a design chat on the fixture app, which asks the fidelity question; the answer
 * is `fidelity` and the designer then runs `script`. Resolves once the answer is submitted.
 */
export async function startDesignChat(app: ElectronApplication, parent: Page, stub: OpenAIStub, home: Pick<HermeticHome, 'damoclesDir'>, options: DesignChatOptions): Promise<{ design: Page; folder: string }> {
  stub.replies.push(call('StartDesign', { title: 'Contacts list', brief: 'Design the contacts list page.' }), FIDELITY_QUESTION);
  await chatInput(parent).fill('Design the contacts page');
  await chatInput(parent).press('Enter');
  await awaitTurnEnd(parent);
  const design = await designChatPage(app, [parent]);
  const folder = options.findFolder ? await options.findFolder() : designFolder(home.damoclesDir);
  stub.replies.push(...options.script(folder));
  await answerFidelity(design, options.fidelity);
  return { design, folder };
}

export type DesignTab = ShellEditorTab & { designPreview: ShellDesignPreview };

export async function designTabs(app: ElectronApplication): Promise<DesignTab[]> {
  return (await editorState(app)).tabs.filter((tab): tab is DesignTab => tab.kind === 'designPreview');
}

/** The window's design views (their webContents on the design scheme), bottom to top. */
export async function designViews(app: ElectronApplication): Promise<ViewInfo[]> {
  return (await windowViews(app)).filter((view) => view.url.startsWith(DESIGN_SCHEME));
}

/** Runs `code` in the shown design view's page, as the page's own script would. */
export async function inShownDesignView<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }, [scheme, script]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const view = win.contentView.children.find((child) => child instanceof WebContentsView && child.getVisible() && child.webContents.getURL().startsWith(scheme)) as Electron.WebContentsView | undefined;
    if (!view) throw new Error('no design view is shown');
    return view.webContents.executeJavaScript(script, true) as Promise<T>;
  }, [DESIGN_SCHEME, code] as const);
}

/** Records every URL main hands to the OS from now on, without opening any. */
export async function recordOpenExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __designOpened?: string[] }).__designOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => [...((globalThis as { __designOpened?: string[] }).__designOpened ?? [])]);
}
