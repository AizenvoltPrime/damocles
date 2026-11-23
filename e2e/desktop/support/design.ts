import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ShellDesignPreview, ShellEditorTab } from '../../../src/desktop/preload/shell-channels';
import { windowViews, type ViewInfo } from './browser';
import { editorState } from './editor';
import { REPO_ROOT, type HermeticHome } from './hermetic';
import { call, type OpenAIStub, type StubReply } from './openai-stub';
import { SHELL_URL } from './shell';
import { awaitTurnEnd, chatInput, promptReady } from './ui';

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
  await promptReady(question);
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
  await promptReady(prompt);
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

/**
 * Runs `code` in the shown design view's page, as the page's own script would, once a design view is shown: none is while a
 * preview tab opens or switches. Waits rather than throws, since `expect.poll` fails at once when its callback throws.
 */
export async function inShownDesignView<T>(app: ElectronApplication, code: string): Promise<T> {
  let ran: { readonly value: T } | undefined;
  await expect.poll(async () => {
    ran = await app.evaluate(async ({ BrowserWindow, WebContentsView }, [scheme, script, shellUrl]) => {
      const win = BrowserWindow.getAllWindows().find((each) => each.webContents.getURL().startsWith(shellUrl))!;
      const view = win.contentView.children.find((child) => child instanceof WebContentsView && child.getVisible() && child.webContents.getURL().startsWith(scheme)) as Electron.WebContentsView | undefined;
      return view ? { value: await (view.webContents.executeJavaScript(script, true) as Promise<T>) } : undefined;
    }, [DESIGN_SCHEME, code, SHELL_URL] as const);
    return ran !== undefined;
  }, { message: 'a design view is shown' }).toBe(true);
  return ran!.value;
}

/** The shown design view's zoom as main applied it and as its page lays out at it, and the page's CSS width. */
async function shownDesignZoom(app: ElectronApplication): Promise<{ applied: number; inPage: number; width: number } | undefined> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView, screen }, [scheme, shellUrl]) => {
    const win = BrowserWindow.getAllWindows().find((each) => each.webContents.getURL().startsWith(shellUrl))!;
    const view = win.contentView.children.find((child) => child instanceof WebContentsView && child.getVisible() && child.webContents.getURL().startsWith(scheme)) as Electron.WebContentsView | undefined;
    if (!view) return undefined;
    const [ratio, width] = await (view.webContents.executeJavaScript('[devicePixelRatio, innerWidth]', true) as Promise<[number, number]>);
    return { applied: view.webContents.getZoomFactor(), inPage: ratio / screen.getDisplayMatching(win.getBounds()).scaleFactor, width };
  }, [DESIGN_SCHEME, SHELL_URL] as const);
}

/**
 * Waits until the shown design view lays out at its frame's settled zoom. A preset glides the frame for 0.35 s with the view at
 * the new CSS width throughout and its zoom following the frame, and the page's layout moves with the zoom.
 */
export async function settledDesignZoom(app: ElectronApplication, shell: Page): Promise<void> {
  const frame = shell.getByTestId('design-preview-frame');
  await expect(frame).not.toHaveAttribute('data-glide');
  // the frame's width as the shell reports it (content-bounds.ts), over which the shell zooms the page's CSS width
  const frameWidth = await frame.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.round(rect.right) - Math.max(0, Math.round(rect.left));
  });
  await expect.poll(async () => {
    const zoom = await shownDesignZoom(app);
    return zoom !== undefined && Math.abs(zoom.applied - frameWidth / zoom.width) < 0.001 && Math.abs(zoom.inPage - zoom.applied) < 0.001;
  }, { message: 'the design view lays out at its frame\'s zoom' }).toBe(true);
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
