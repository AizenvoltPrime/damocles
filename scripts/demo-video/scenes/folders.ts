import { bootMessages, conversation, FOLDERS, folderKey, settings, windowTitle } from '../lib/script.ts';
import type { Scene } from '../lib/scene.ts';

const WEB_SID = '0197a3c9-8d02-7c4e-b1a7-5e3f9a2c6d18';
const CART_PATH = 'c:/dev/acme-web/src/hooks/useCart.ts';
const ANSWER = "`useCart` starts with `items: []` and fetches in an effect, so the page renders an empty cart for one frame. I'll seed it from the server-rendered cart instead.";

export const folders: Scene = {
  id: 'folders',
  chapter: 'Workspace folders',
  accent: 'cyan',
  boot: bootMessages({ mode: 'acceptEdits', yolo: true }),
  async run(stage) {
    const api = conversation(stage);
    await stage.caption('In a multi-root workspace, each panel works in its own folder.');
    await api.prompt('Where do we hash passwords?', { typeDelayMs: 22 });
    api.startMessage();
    const answer = 'In `src/auth/password.ts`, with argon2id.';
    await api.say(answer);
    await api.seal();
    await api.endTurn(answer);
    await stage.pause(700);

    const chip = stage.page.getByTestId('workspace-folder-chip');
    stage.mark('gif-start');
    await stage.focus(chip, { maxZoom: 1.7 });
    await stage.pause(900);
    await stage.click(chip);
    await stage.pause(1100);
    const requested = stage.waitForPost('setPanelWorkspaceFolder');
    await stage.click(stage.page.getByTestId('workspace-folder-option').filter({ hasText: 'acme-web' }));
    await requested;
    await stage.pause(700);
    const web = folderKey('acme-web');
    await stage.send(
      { type: 'settingsUpdate', settings: settings('acceptEdits', true) },
      { type: 'workspaceFolderUpdate', folders: FOLDERS, panelFolderKey: web, defaultFolderKey: folderKey('acme-api'), switched: true },
      { type: 'mcpConfigUpdate', servers: [], configErrors: [], localMcpUnignored: false },
      { type: 'sessionStarted', sessionId: WEB_SID },
    );
    stage.windowTitle(windowTitle('acme-web'));
    await stage.pause(400);
    stage.unfocus();
    await stage.caption('Switching starts a fresh chat there, with that folder\'s memory, MCP and commands.');
    await stage.pause(1600);
    stage.mark('gif-end');

    const c = conversation(stage, { sessionId: WEB_SID });
    await c.prompt('Why does the checkout page flash an empty cart on load?');
    c.startMessage();
    await c.think('The flash is probably initial state. Check how useCart initialises.', 1);
    const read = { file_path: CART_PATH };
    await c.callTool('toolu_web_read', 'Read', read);
    await c.seal();
    await c.runTool('toolu_web_read', 'Read', read, 'export function useCart() {\n  const [items, setItems] = useState<CartItem[]>([]);\n  useEffect(() => { fetchCart().then(setItems); }, []);', { durationMs: 10 });
    c.startMessage();
    await c.say(ANSWER, 170);
    await c.seal();
    await c.bill({ totalInputTokens: 2900, totalOutputTokens: 140, cacheReadTokens: 16000, cacheCreationTokens: 1800, costUsd: 0.034 });
    await c.endTurn(ANSWER);
    await stage.pause(2200);
  },
};
