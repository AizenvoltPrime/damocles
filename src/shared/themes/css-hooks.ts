// The data-* attributes theme CSS may select on, per region (docs/themes.md "Hooks"): names and values kept across versions,
// a value set that may only grow. Each sits strictly inside its region's scope root. A leaf module: it imports nothing.

export interface CssHook {
  // an attribute selector without a value, as a theme writes it before adding one
  readonly selector: string;
  // the values it takes; empty: only present or absent; null: it holds a name
  readonly values: readonly string[] | null;
  readonly meaning: string;
}

const AVATAR_HOOKS: readonly CssHook[] = [
  { selector: '[data-avatar]', values: ['letter', 'character'], meaning: 'On a project\'s avatar: `letter` for the project\'s initial on its color, `character` for the theme\'s character.' },
  { selector: '[data-character]', values: null, meaning: 'On a character avatar: the character\'s name.' },
  { selector: '[data-character-state]', values: ['idle', 'running', 'waiting'], meaning: 'On a character avatar: the state it shows.' },
  { selector: '[data-character-moving]', values: ['true', 'false'], meaning: 'On a character avatar: whether it moves now.' },
  { selector: '[data-selection]', values: ['outline', 'none'], meaning: 'On a character avatar: the character set\'s `selection`, how the selected project\'s character is marked.' },
];

// Must match CSS_REGIONS in schema.ts (css-hooks.test.ts).
export type CssHookRegion = 'transcript' | 'sidebar' | 'titlebar' | 'editorChrome' | 'terminalChrome';

export const CSS_HOOKS: Readonly<Record<CssHookRegion, readonly CssHook[]>> = {
  transcript: [
    { selector: '[data-tool-card]', values: [], meaning: 'On every tool card.' },
    { selector: '[data-tool]', values: null, meaning: 'On a tool card: the tool\'s own name, such as `Bash`, `Read`, `Edit`, `Agent`, `ThemeSet` or an MCP tool\'s full name.' },
    {
      selector: '[data-tool-status]',
      values: ['running', 'done', 'error', 'stopped', 'blocked'],
      meaning: 'On a tool card: `running` (started or about to), `done`, `error` (failed or denied), `stopped` (cancelled, never ran, or its outcome was not recorded) or `blocked` (waiting for your answer, or blocked by a rule). An agent or team card has the status of its agent or its run, not of the call that started it: a background agent\'s card is `running` until the agent ends, and a team\'s is `blocked` while a member waits for your answer.',
    },
    {
      selector: '[data-part]',
      values: ['header', 'tile', 'summary', 'body'],
      meaning: 'Inside a tool card: `header` (the card\'s top row), `tile` (the icon tile in it), `summary` (the call\'s one-line argument in it) and `body` (what the card shows below its header; a card with nothing there has none, and a folded detail still counts). Agent and team cards have `header` and `tile`.',
    },
  ],
  sidebar: [
    { selector: '[data-project-row]', values: [], meaning: 'On each project row of the Projects section.' },
    { selector: '[data-project-state]', values: ['idle', 'running', 'waiting'], meaning: 'On a project row: `waiting` while one of its chats waits on you, else `running` while one runs, else `idle`.' },
    { selector: '[data-chat-row]', values: [], meaning: 'On each chat row of the Chats section.' },
    { selector: '[data-chat-state]', values: ['idle', 'running', 'waiting'], meaning: 'On a chat row: `waiting` while the chat waits on you, `running` while it runs, else `idle`.' },
    { selector: '[data-selected]', values: [], meaning: 'On the selected project row and its avatar, and on the selected chat row.' },
    ...AVATAR_HOOKS,
  ],
  titlebar: [
    { selector: '[data-part]', values: ['brand', 'project', 'chat'], meaning: '`brand` (the Damocles button), `project` (the breadcrumb\'s project, its avatar and name) and `chat` (the breadcrumb\'s chat title, once the chat has one).' },
    ...AVATAR_HOOKS,
  ],
  editorChrome: [
    { selector: '[data-editor-tab]', values: [], meaning: 'On each editor tab.' },
    { selector: '[data-active]', values: [], meaning: 'On the active editor tab.' },
    { selector: '[data-dirty]', values: [], meaning: 'On a tab with unsaved changes.' },
    { selector: '[data-breadcrumb-item]', values: ['place', 'path', 'current'], meaning: 'On each shown item of the breadcrumbs: `place` (the project folder or worktree the file is in), `path` (each item before the last: the project or host, then the folders) and `current` (the last item: the file, or a page\'s host).' },
  ],
  terminalChrome: [
    { selector: '[data-terminal-row]', values: [], meaning: 'On each row of the terminal list.' },
    { selector: '[data-active]', values: [], meaning: 'On the active terminal\'s row.' },
    { selector: '[data-status]', values: ['starting', 'running', 'exited', 'reconnecting'], meaning: 'On a terminal row: the terminal\'s state.' },
  ],
};
