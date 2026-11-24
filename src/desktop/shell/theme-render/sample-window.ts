// The theme render page's sample content: what the drawn preview shows in the real components. It lives in the page bundle;
// main sends none of it, and the page draws it in English.
import type { ChatMessage } from '@shared/types/session';
import type { ShellChat, ShellPlatform, ShellProject } from '../../preload/shell-channels';
import type { TitleBarState } from '../components/title-bar-api';
import type { Arrangement } from '@shared/themes/schema';

export const SAMPLE_SELECTED_PROJECT = 'local:/work/damocles';
// its name, whose hue marks the selected project's character
export const SAMPLE_SELECTED_NAME = 'damocles';
export const SAMPLE_SELECTED_CHAT = 'sample-chat-theme';

const local = { key: 'local', kind: 'local', name: 'This computer' } as const;

/** Four projects: the selected one idle, one running, one waiting, and one on a remote host, whose row shows its host badge. */
export function sampleProjects(platform: ShellPlatform): readonly ShellProject[] {
  const home = platform === 'win32' ? 'C:\\work' : '/work';
  const separator = platform === 'win32' ? '\\' : '/';
  const at = (name: string): Pick<ShellProject, 'fsPath' | 'platform' | 'trash' | 'trusted' | 'connection' | 'authority'> =>
    ({ fsPath: `${home}${separator}${name}`, platform, trash: true, trusted: true, connection: 'connected', authority: local });
  return [
    { key: SAMPLE_SELECTED_PROJECT, name: SAMPLE_SELECTED_NAME, ...at(SAMPLE_SELECTED_NAME), branch: 'main', running: 0, waiting: 0 },
    { key: 'local:/work/atlas', name: 'atlas', ...at('atlas'), branch: 'feature/tiles', running: 1, waiting: 0 },
    { key: 'local:/work/harbor', name: 'harbor', ...at('harbor'), branch: 'release/2.4', running: 0, waiting: 1 },
    {
      key: 'ssh+build:/srv/relay',
      name: 'relay',
      fsPath: '/srv/relay',
      platform: 'linux',
      trash: false,
      trusted: true,
      connection: 'connected',
      authority: { key: 'ssh+build', kind: 'ssh', hostId: 'build', name: 'build-01' },
      branch: 'main',
      running: 0,
      waiting: 0,
    },
  ];
}

/**
 * Three chats of the selected project, the open one, one running and one older: 2, 18 and 95 minutes before `now`, none before
 * the local midnight that started its day, so the list groups them all under Today at any time of day.
 */
export function sampleChats(now: number): readonly ShellChat[] {
  const at = new Date(now);
  const startOfToday = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const minutes = (count: number): number => Math.max(startOfToday, now - count * 60_000);
  const chat = (id: string, title: string, timestamp: number, status: ShellChat['status']): ShellChat =>
    ({ id, title, timestamp, status, loaded: true, readOnly: false, actions: [], model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } });
  return [
    chat(SAMPLE_SELECTED_CHAT, 'Tune the sidebar theme', minutes(2), 'idle'),
    chat('sample-chat-tests', 'Fix the flaky upload test', minutes(18), 'running'),
    chat('sample-chat-docs', 'Write the release notes', minutes(95), 'idle'),
  ];
}

/** The title bar's state: the selected project and chat, the arrangement's panes, and nothing waiting in the bell. */
export function sampleTitleBarState(platform: ShellPlatform, kind: 'dark' | 'light', arrangement: Required<Arrangement>, now: number): TitleBarState {
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';
  const selected = sampleChats(now)[0]!;
  return {
    projects: sampleProjects(platform),
    selected: { projectKey: SAMPLE_SELECTED_PROJECT, chatId: selected.id },
    selectedChat: { id: selected.id, title: selected.title, status: selected.status },
    hosts: [],
    effectiveTheme: kind,
    notifications: { unseen: 0, doNotDisturb: false, popupsOff: false, attention: 0 },
    platform,
    engineHalted: false,
    engines: [],
    windowState: 'normal',
    shortcuts: { toggleSidebar: `${mod}B`, settings: `${mod},`, quickOpen: `${mod}P`, toggleTerminal: `${mod}\`` },
    layout: { sidebarVisible: true, grid: { ...arrangement.grid, maximized: null } },
  };
}

const SAMPLE_FILE = 'src/theme/palette.ts';
const SAMPLE_CODE = `export function readable(color: Oklch, ground: Oklch): Oklch {
  const lift = contrast(color, ground) < 4.5 ? 0.12 : 0;
  return { ...color, l: Math.min(1, color.l + lift) };
}`;

/** A user message, then a reply that read a file with a completed Read and answers with a code block. */
export function sampleMessages(now: number): ChatMessage[] {
  const readId = 'sample-read';
  return [
    {
      id: 'sample-user',
      role: 'user',
      content: 'The muted text on the sidebar is hard to read over the wallpaper. Can you lift it?',
      timestamp: now - 120_000,
      promptIndex: 0,
    },
    {
      id: 'sample-reply',
      role: 'assistant',
      content: '',
      timestamp: now - 110_000,
      contentBlocks: [
        { type: 'tool_use', id: readId, name: 'Read', input: { file_path: SAMPLE_FILE } },
        { type: 'text', text: `The palette darkens muted text but never checks it against the wallpaper's dim. This lifts its lightness until it reads at 4.5:1:\n\n\`\`\`ts\n${SAMPLE_CODE}\n\`\`\`` },
      ],
      toolCalls: [{ id: readId, name: 'Read', input: { file_path: SAMPLE_FILE }, status: 'completed', result: SAMPLE_CODE, durationMs: 40 }],
    },
  ];
}
