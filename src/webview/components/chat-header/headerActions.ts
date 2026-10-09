/** What a chat header control asks App.vue to open; App.vue maps each to its existing handler. */
export type HeaderAction =
  | 'consolidation'
  | 'viewPlan'
  | 'bindPlan'
  | 'memory'
  | 'browser'
  | 'mcp'
  | 'tools'
  | 'rewind'
  | 'sideQuestion'
  | 'viewAside'
  | 'context'
  | 'usage'
  | 'stats'
  | 'settings'
  | 'terminal';
