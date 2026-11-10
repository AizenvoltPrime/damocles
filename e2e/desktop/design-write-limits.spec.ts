import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from './support/fixtures';
import { DESIGN_APP, designChatPage, designFolder } from './support/design';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { agentRequests, call, startOpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { awaitTurnEnd, chatInput } from './support/ui';

// D64, D65 and D100 end to end: under YOLO a design chat's write to the project folder, its write of the core-owned manifest.json,
// its write of a nested shared/ path and its shell command that is not read-only are each Blocked with the policy reason, and
// none of them changes a file; its write of shared/base.css lands, and RemoveDesignFile refuses tokens.css.

test.describe.configure({ timeout: 300_000 });

test('under YOLO a design chat\'s project write, manifest.json write, nested shared/ write and shell write are each Blocked and change no file', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.dangerouslySkipPermissions': true });
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const parent = await openProjectChat(app, home.project);

    const projectFile = path.join(home.project, 'designer-note.txt');
    const shellFile = path.join(home.project, 'shell-note.txt');
    let releaseDesigner!: () => void;
    const yoloChecked = new Promise<void>((resolve) => { releaseDesigner = resolve; });
    stub.replies.push(
      call('StartDesign', { title: 'Contacts list', brief: 'Design the contacts list page: a searchable table of contacts.' }),
      // Held until the test has seen the design chat run under YOLO and queued the rest of the script.
      { ...call('write', { path: projectFile, content: 'from the designer' }), holdAfterFirst: yoloChecked },
    );
    await chatInput(parent).fill('Design the contacts page before we build it');
    await chatInput(parent).press('Enter');
    await expect(parent.getByTestId('start-design-card')).toContainText('Design chat opened');
    await awaitTurnEnd(parent);

    const design = await designChatPage(app, [parent]);
    // Tall enough that the virtualized transcript keeps every card of the run mounted.
    await setPageSize(design, 900, 6000);
    await expect(design.getByTestId('composer-mode')).toHaveAttribute('data-mode', 'design');
    await expect(design.getByTestId('composer-yolo')).toHaveAttribute('aria-pressed', 'true');

    const folder = designFolder(home.damoclesDir);
    const manifest = path.join(folder, 'manifest.json');
    const manifestBefore = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    const sharedCss = path.join(folder, 'shared', 'base.css');
    const nestedShared = path.join(folder, 'shared', 'shell', 'base.css');
    const tokens = path.join(folder, 'tokens.css');
    fs.writeFileSync(tokens, ':root { --space-1: 0.25rem; }');
    stub.replies.push(
      call('write', { path: manifest, content: '{"forged":true}' }),
      call('write', { path: sharedCss, content: '.shell { padding: var(--space-1); }' }),
      call('write', { path: nestedShared, content: '.shell {}' }),
      call('RemoveDesignFile', { file: 'tokens.css' }),
      call('bash', { command: `echo ran > ${path.basename(shellFile)}` }),
      { chunks: ['Tried the writes.'] },
    );
    releaseDesigner();

    await expect(design.getByText('Tried the writes.')).toBeVisible();
    await awaitTurnEnd(design);
    const blocked = design.getByTestId('tool-card-blocked');
    await expect(blocked).toHaveCount(4);
    await expect(blocked.first()).toHaveText('Blocked');
    const reasons = design.getByTestId('tool-card-blocked-reason');
    await expect(reasons).toHaveCount(4);
    await expect(reasons.nth(0)).toContainText('is outside it');
    await expect(reasons.nth(1)).toContainText('A design chat writes only design.md, screens/<name>.html, shared/<name>.css, shared/<name>.js and files under variants/');
    await expect(reasons.nth(2)).toContainText('A design chat writes only design.md');
    await expect(reasons.nth(3)).toContainText('proven read-only');

    expect(fs.existsSync(projectFile)).toBe(false);
    // Core rewrites the manifest itself as the turn settles, which moves only its `updatedAt`.
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))).toEqual({ ...manifestBefore, updatedAt: expect.any(String) });
    expect(fs.existsSync(shellFile)).toBe(false);
    expect(fs.readFileSync(sharedCss, 'utf8')).toBe('.shell { padding: var(--space-1); }');
    expect(fs.existsSync(nestedShared)).toBe(false);
    expect(fs.readFileSync(tokens, 'utf8')).toBe(':root { --space-1: 0.25rem; }');
    const removal = agentRequests(stub).map((request) => JSON.stringify(request.body)).find((body) => body.includes('RemoveDesignFile removed nothing'));
    expect(removal).toContain('tokens.css is not a screen, variant or shared file of this design');
    // Every scripted reply was used and no run past the script asked for one.
    expect(stub.replies).toHaveLength(0);
  } finally {
    await stub.close();
  }
});
