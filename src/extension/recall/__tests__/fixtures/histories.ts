import type { StructuredTurn, ToolCallRecord } from '../../types';

function makeTurn(overrides: Partial<StructuredTurn> & { promptIndex: number }): StructuredTurn {
  return {
    timestamp: new Date(Date.UTC(2025, 0, 1) + overrides.promptIndex * 60_000).toISOString(),
    userMessage: 'test message',
    assistantResponse: 'test response',
    toolCalls: [],
    thinkingBlocks: [],
    filesTouched: [],
    ...overrides,
  };
}

export function createCardGameHistory(): StructuredTurn[] {
  return [
    makeTurn({
      promptIndex: 0,
      userMessage: 'I want to create a card game in Godot. Can you help me set up the project structure?',
      assistantResponse: 'I\'ll help you set up a card game project in Godot. Let me create the base project structure with a Main scene, a CardManager for handling the deck, and a global InputManager autoload for handling user interactions. The InputManager will be registered as an autoload singleton so it can process input events globally across all scenes.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'project.godot' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/Main.gd' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/CardManager.gd' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/InputManager.gd' }, result: 'File written' },
      ],
      filesTouched: ['project.godot', 'src/Main.gd', 'src/CardManager.gd', 'src/InputManager.gd'],
    }),
    makeTurn({
      promptIndex: 1,
      userMessage: 'Now add a Card scene with drag and drop functionality',
      assistantResponse: 'I\'ve created a Card scene with drag and drop. The Card extends Area2D and uses input events from the InputManager to handle mouse drag operations. Each card has a TextureRect for the card image and a CollisionShape2D for click detection.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'src/Card.gd' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/Card.tscn' }, result: 'File written' },
      ],
      filesTouched: ['src/Card.gd', 'src/Card.tscn'],
    }),
    makeTurn({
      promptIndex: 2,
      userMessage: 'Add a hand display that fans cards out in an arc',
      assistantResponse: 'I\'ve created a HandDisplay node that arranges cards in an arc using trigonometric calculations. Each card is positioned using sin/cos with a configurable arc_angle (default 30 degrees) and arc_radius. I also added hover highlighting — when you mouse over a card, it rises up with a tween animation.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'src/HandDisplay.gd' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/HandDisplay.tscn' }, result: 'File written' },
      ],
      filesTouched: ['src/HandDisplay.gd', 'src/HandDisplay.tscn'],
    }),
    makeTurn({
      promptIndex: 3,
      userMessage: 'There\'s a bug - cards are flickering when I hover over them. The hover effect keeps triggering',
      assistantResponse: 'The flickering is caused by a z-index race condition. When a card rises on hover, it overlaps with adjacent cards, triggering their mouse_entered signals which causes a cascade of enter/exit events. Fixed by adding a 50ms debounce to the hover detection and using a mutex flag _hover_locked to prevent re-entry during the tween animation.',
      toolCalls: [
        { name: 'Read', input: { file_path: 'src/HandDisplay.gd' }, result: 'extends Node2D...' },
        { name: 'Edit', input: { file_path: 'src/HandDisplay.gd', old_string: 'func _on_card_hover', new_string: 'var _hover_locked := false\nfunc _on_card_hover' }, result: 'File edited' },
      ],
      filesTouched: ['src/HandDisplay.gd'],
    }),
    makeTurn({
      promptIndex: 4,
      userMessage: 'Add a deck data structure that loads card definitions from JSON',
      assistantResponse: 'Created a DeckLoader that reads card definitions from res://data/cards.json. Each card definition has id, name, cost, attack, health, description, and art_path fields. The DeckLoader validates the JSON schema on load and returns an array of CardData resources.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'src/DeckLoader.gd' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/CardData.gd' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'data/cards.json' }, result: 'File written' },
      ],
      filesTouched: ['src/DeckLoader.gd', 'src/CardData.gd', 'data/cards.json'],
    }),
    makeTurn({
      promptIndex: 5,
      userMessage: 'Implement a turn system with phases: draw, main, combat, end',
      assistantResponse: 'Implemented a TurnManager with a state machine pattern. The phases are: DRAW (player draws a card), MAIN (player can play cards and use abilities), COMBAT (resolve attacks), END (cleanup and pass turn). Each phase has enter/exit callbacks. I also added a mana system — players start with 1 mana and gain +1 each turn up to 10.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'src/TurnManager.gd' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/ManaSystem.gd' }, result: 'File written' },
      ],
      filesTouched: ['src/TurnManager.gd', 'src/ManaSystem.gd'],
    }),
    makeTurn({
      promptIndex: 6,
      userMessage: 'The mana system has a bug - mana doesn\'t reset at the start of each turn',
      assistantResponse: 'Found the issue — TurnManager.enter_draw_phase() was calling ManaSystem.add_mana(1) but not ManaSystem.reset_current(). The reset needs to happen before adding the new mana. Fixed by adding reset_current() at the start of enter_draw_phase().',
      toolCalls: [
        { name: 'Read', input: { file_path: 'src/TurnManager.gd' }, result: 'extends Node...' },
        { name: 'Edit', input: { file_path: 'src/TurnManager.gd', old_string: 'func enter_draw_phase', new_string: 'func enter_draw_phase' }, result: 'File edited' },
        { name: 'Read', input: { file_path: 'src/ManaSystem.gd' }, result: 'extends Node...' },
        { name: 'Edit', input: { file_path: 'src/ManaSystem.gd', old_string: 'func add_mana', new_string: 'func reset_current' }, result: 'File edited' },
      ],
      filesTouched: ['src/TurnManager.gd', 'src/ManaSystem.gd'],
    }),
  ];
}

export function createWebAppHistory(): StructuredTurn[] {
  return [
    makeTurn({
      promptIndex: 0,
      userMessage: 'Set up a Next.js app with authentication using NextAuth',
      assistantResponse: 'I\'ve set up a Next.js 14 app with NextAuth.js for authentication. The auth configuration supports Google and GitHub OAuth providers. I created an AuthProvider wrapper component and a middleware for protected routes.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'src/app/api/auth/[...nextauth]/route.ts' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/components/AuthProvider.tsx' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/middleware.ts' }, result: 'File written' },
      ],
      filesTouched: ['src/app/api/auth/[...nextauth]/route.ts', 'src/components/AuthProvider.tsx', 'src/middleware.ts'],
    }),
    makeTurn({
      promptIndex: 1,
      userMessage: 'Add a dashboard page with user profile sidebar',
      assistantResponse: 'Created a dashboard layout with a responsive sidebar showing user avatar, name, and email from the session. The sidebar collapses to an icon bar on mobile using Tailwind responsive classes.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'src/app/dashboard/page.tsx' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/components/Sidebar.tsx' }, result: 'File written' },
      ],
      filesTouched: ['src/app/dashboard/page.tsx', 'src/components/Sidebar.tsx'],
    }),
    makeTurn({
      promptIndex: 2,
      userMessage: 'Add a PostgreSQL database with Prisma ORM',
      assistantResponse: 'Set up Prisma with PostgreSQL. The schema has User, Post, and Comment models with proper relations. I created a PrismaClient singleton in src/lib/db.ts to prevent connection pooling issues in development.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'prisma/schema.prisma' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/lib/db.ts' }, result: 'File written' },
      ],
      filesTouched: ['prisma/schema.prisma', 'src/lib/db.ts'],
    }),
    makeTurn({
      promptIndex: 3,
      userMessage: 'I\'m getting a CORS error when trying to fetch from the API on localhost:3001',
      assistantResponse: 'The CORS error is happening because your frontend (localhost:3000) is making requests to a different origin (localhost:3001). Fixed by adding CORS headers in next.config.js and creating a proxy configuration for development.',
      toolCalls: [
        { name: 'Read', input: { file_path: 'next.config.js' }, result: 'module.exports = {}' },
        { name: 'Edit', input: { file_path: 'next.config.js', old_string: 'module.exports', new_string: 'module.exports' }, result: 'File edited' },
      ],
      filesTouched: ['next.config.js'],
    }),
    makeTurn({
      promptIndex: 4,
      userMessage: 'Create a blog post editor with Markdown preview',
      assistantResponse: 'Built a blog post editor with real-time Markdown preview using a split-pane layout. Posts are saved as drafts automatically every 30 seconds via a custom useAutosave hook.',
      toolCalls: [
        { name: 'Write', input: { file_path: 'src/app/editor/page.tsx' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/components/MarkdownEditor.tsx' }, result: 'File written' },
        { name: 'Write', input: { file_path: 'src/hooks/useAutosave.ts' }, result: 'File written' },
      ],
      filesTouched: ['src/app/editor/page.tsx', 'src/components/MarkdownEditor.tsx', 'src/hooks/useAutosave.ts'],
    }),
    makeTurn({
      promptIndex: 5,
      userMessage: 'The autosave is firing too many requests, it needs to be debounced',
      assistantResponse: 'Fixed the autosave by implementing proper debouncing. The previous implementation used setInterval which fired regardless of changes. Network requests dropped from ~120/min to ~2-4/min.',
      toolCalls: [
        { name: 'Read', input: { file_path: 'src/hooks/useAutosave.ts' }, result: 'export function useAutosave...' },
        { name: 'Edit', input: { file_path: 'src/hooks/useAutosave.ts', old_string: 'setInterval', new_string: 'debounce' }, result: 'File edited' },
      ],
      filesTouched: ['src/hooks/useAutosave.ts'],
    }),
  ];
}

export function createLargeHistory(count: number): StructuredTurn[] {
  const topics = ['authentication', 'database', 'API endpoints', 'caching', 'deployment', 'testing', 'UI components', 'state management', 'error handling', 'performance'];
  const topicPrompts: Record<string, string[]> = {
    authentication: ['set up JWT auth', 'add refresh tokens', 'fix session expiry', 'add 2FA support', 'audit auth logs'],
    database: ['create schema', 'add migrations', 'optimize queries', 'add indexes', 'set up replication'],
    'API endpoints': ['create REST endpoints', 'add validation', 'implement pagination', 'add rate limiting', 'add versioning'],
    caching: ['set up Redis', 'cache API responses', 'invalidate on write', 'add TTL policies', 'cache warming'],
    deployment: ['set up Docker', 'create CI/CD', 'configure staging', 'add health checks', 'set up monitoring'],
    testing: ['unit tests for auth', 'integration tests for API', 'e2e tests for dashboard', 'load tests for cache', 'coverage reports'],
    'UI components': ['create button system', 'build form components', 'add modal dialogs', 'create data tables', 'add toast notifications'],
    'state management': ['set up Redux store', 'create auth slice', 'add middleware', 'optimize selectors', 'add persistence'],
    'error handling': ['global error boundary', 'API error handling', 'form validation errors', 'retry logic', 'error reporting to Sentry'],
    performance: ['code splitting for routes', 'lazy loading images', 'image optimization pipeline', 'bundle analysis report', 'lighthouse audit fixes'],
  };

  return Array.from({ length: count }, (_, i) => {
    const topic = topics[i % topics.length]!;
    const slug = topic.replace(/\s+/g, '-').toLowerCase();
    const subTask = (topicPrompts[topic] ?? ['generic task'])[i % (topicPrompts[topic]?.length ?? 1)]!;

    return makeTurn({
      promptIndex: i,
      userMessage: `Work on ${topic}: ${subTask}`,
      assistantResponse: `Implemented ${subTask} for the ${topic} module. Updated the relevant files in src/${slug}/ with the necessary changes. Key decisions: followed existing patterns in the codebase for consistency. I reviewed the existing code structure, identified the right integration points, and made the modifications while ensuring backward compatibility. The implementation includes proper error handling, type safety, and follows the project conventions established in earlier turns.`,
      toolCalls: [
        { name: i % 2 === 0 ? 'Write' : 'Edit', input: { file_path: `src/${slug}/index.ts` }, result: 'Success' },
        { name: 'Read', input: { file_path: `src/${slug}/config.ts` }, result: 'File content...' },
      ],
      filesTouched: [`src/${slug}/index.ts`, `src/${slug}/config.ts`],
    });
  });
}

export function createMinimalTurn(overrides: Partial<StructuredTurn> & { promptIndex: number }): StructuredTurn {
  return makeTurn(overrides);
}
