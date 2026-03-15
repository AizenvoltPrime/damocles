import type { StructuredTurn } from '../../types';

export function makeTurn(overrides: Partial<StructuredTurn> & { promptIndex: number }): StructuredTurn {
  return {
    timestamp: new Date(Date.UTC(2025, 0, 1) + overrides.promptIndex * 60_000).toISOString(),
    userMessage: 'test message',
    assistantResponse: 'test response',
    toolCalls: [],
    contentBlocks: [],
    thinkingBlocks: [],
    filesTouched: [],
    nodeId: null,
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
      userMessage: 'I\'m getting a CORS error when trying to fetch from the API on localhost:3001. The browser console shows: "Access to fetch at http://localhost:3001/api/posts from origin http://localhost:3000 has been blocked by CORS policy: No \'Access-Control-Allow-Origin\' header is present on the requested resource."',
      assistantResponse: 'The CORS error is happening because your frontend (localhost:3000) is making requests to a different origin (localhost:3001). The browser enforces same-origin policy and blocks the response when the server doesn\'t include the Access-Control-Allow-Origin header.\n\nI fixed this in two ways:\n1. Added CORS headers to next.config.js with `headers()` config — sets `Access-Control-Allow-Origin: http://localhost:3000`, `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`, and `Access-Control-Allow-Headers: Content-Type, Authorization`\n2. Created a proxy rewrite rule in next.config.js `rewrites()` to forward `/api/:path*` requests to `http://localhost:3001/api/:path*` during development, which avoids CORS entirely by keeping requests same-origin\n\nThe proxy approach is better for development since it eliminates CORS complexity entirely. The explicit headers are a fallback for production where the API runs on a different domain.',
      toolCalls: [
        { name: 'Read', input: { file_path: 'next.config.js' }, result: 'module.exports = {}' },
        { name: 'Edit', input: { file_path: 'next.config.js', old_string: 'module.exports = {}', new_string: 'module.exports = { async headers() { return [{ source: "/api/:path*", headers: [{ key: "Access-Control-Allow-Origin", value: "http://localhost:3000" }] }] }, async rewrites() { return [{ source: "/api/:path*", destination: "http://localhost:3001/api/:path*" }] } }' }, result: 'File edited' },
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

interface OverlappingTurnSpec {
  promptIndex: number;
  userMessage: string;
  assistantResponse: string;
  filesTouched?: string[];
}

export function createOverlappingHistory(): StructuredTurn[] {
  const specs: OverlappingTurnSpec[] = [
    // --- Early filler (turns 0-4) ---
    { promptIndex: 0, userMessage: 'Set up the project scaffolding with TypeScript and ESLint', assistantResponse: 'Created project structure with TypeScript strict mode, ESLint flat config, and tsconfig paths configured.' },
    { promptIndex: 1, userMessage: 'Add Express server with basic health endpoint', assistantResponse: 'Set up Express with a /health endpoint returning 200 OK. Added graceful shutdown handler.' },
    { promptIndex: 2, userMessage: 'Create the User model with Prisma', assistantResponse: 'Defined User model in Prisma schema with id, email, name, createdAt fields. Generated the client.' },
    { promptIndex: 3, userMessage: 'Add request logging middleware', assistantResponse: 'Created morgan-based logging middleware with custom format. Logs method, URL, status, and response time.' },
    { promptIndex: 4, userMessage: 'Set up environment variable validation with zod', assistantResponse: 'Created env.ts with zod schema validating DATABASE_URL, JWT_SECRET, PORT. Throws on startup if invalid.' },

    // --- Auth cluster 1 (turns 5-15): "session" + "auth" + "database" bleeding ---
    { promptIndex: 5, userMessage: 'Set up authentication with JWT tokens and create the auth tables in PostgreSQL', assistantResponse: 'Implemented JWT authentication. Created users and refresh_tokens tables in PostgreSQL. The session token uses HS256 with 15min expiry. Refresh tokens stored in httpOnly cookies with 7-day TTL.', filesTouched: ['src/auth/jwt.ts', 'prisma/schema.prisma', 'src/auth/middleware.ts'] },
    { promptIndex: 6, userMessage: 'Add password hashing with bcrypt for user registration', assistantResponse: 'Added bcrypt password hashing with 12 salt rounds. Created /register endpoint that validates email uniqueness before creating the user record.', filesTouched: ['src/auth/register.ts', 'src/auth/hash.ts'] },
    { promptIndex: 7, userMessage: 'Implement the login endpoint with rate limiting', assistantResponse: 'Created /login endpoint that verifies credentials and returns access + refresh token pair. Added rate limiting at 5 attempts per IP per 15 minutes using express-rate-limit.', filesTouched: ['src/auth/login.ts', 'src/auth/rate-limit.ts'] },
    { promptIndex: 8, userMessage: 'yes, do that', assistantResponse: 'Applied the rate limiting configuration. Also added the failed login attempt counter that resets after successful authentication.' },
    { promptIndex: 9, userMessage: 'Add role-based access control with admin and user roles', assistantResponse: 'Extended the User model with a role enum (ADMIN, USER). Created authorization middleware that checks JWT claims for role. Protected admin routes.', filesTouched: ['src/auth/rbac.ts', 'prisma/schema.prisma'] },
    { promptIndex: 10, userMessage: 'Fix the JWT refresh token rotation vulnerability', assistantResponse: 'Fixed refresh token reuse detection. When a refresh token is used, we now invalidate the entire token family (all descendants). This prevents replay attacks where a stolen refresh token could be used after rotation.' },
    { promptIndex: 11, userMessage: 'Add OAuth2 Google provider for social login', assistantResponse: 'Integrated Google OAuth2 using passport-google-oauth20. Created callback handler that upserts users by email and links the Google profile ID.', filesTouched: ['src/auth/google-oauth.ts', 'src/auth/passport.ts'] },
    { promptIndex: 12, userMessage: 'Implement session caching for auth tokens to reduce database lookups', assistantResponse: 'Added Redis-based session caching for validated auth tokens. Cache TTL matches the JWT expiry (15min). On token validation, we first check Redis, then fall back to database verification. Reduced auth middleware latency from ~50ms to ~2ms for cached sessions.', filesTouched: ['src/auth/session-cache.ts', 'src/cache/redis-client.ts'] },
    { promptIndex: 13, userMessage: 'Add CSRF protection for the auth endpoints', assistantResponse: 'Implemented double-submit cookie CSRF protection. The token is set in a non-httpOnly cookie and must be sent in the X-CSRF-Token header. Exempt the login and register endpoints.', filesTouched: ['src/auth/csrf.ts'] },
    { promptIndex: 14, userMessage: 'Write unit tests for the authentication middleware', assistantResponse: 'Created test suite for auth middleware: valid token passes, expired token returns 401, missing token returns 401, invalid signature returns 403, rate-limited IP returns 429.', filesTouched: ['src/auth/__tests__/middleware.test.ts'] },
    { promptIndex: 15, userMessage: 'Add session invalidation endpoint for logout across all devices', assistantResponse: 'Created /logout-all endpoint that invalidates all refresh tokens for the user. Clears the Redis session cache entries. Increments a tokenVersion counter on the User model so all existing JWTs become invalid on next verification.', filesTouched: ['src/auth/logout.ts', 'src/auth/session-cache.ts'] },

    // --- General database work (turns 16-21): overlaps "database" keyword with auth ---
    { promptIndex: 16, userMessage: 'Set up database connection pooling with PgBouncer', assistantResponse: 'Configured PgBouncer in transaction mode. Updated DATABASE_URL to point through the pooler. Set pool_size=20, max_client_conn=100.' },
    { promptIndex: 17, userMessage: 'Create database migration for the posts and comments tables', assistantResponse: 'Created posts table with id, title, content, authorId, publishedAt. Comments table with id, postId, authorId, body, createdAt. Added foreign keys and indexes.', filesTouched: ['prisma/schema.prisma'] },
    { promptIndex: 18, userMessage: 'Add full-text search to the posts table using PostgreSQL tsvector', assistantResponse: 'Added a search_vector column with GIN index. Created a trigger that updates the tsvector on INSERT/UPDATE. The search API uses ts_rank for relevance ordering.' },
    { promptIndex: 19, userMessage: 'Optimize the slow query on the posts listing page', assistantResponse: 'The N+1 query on posts with author and comment count was doing 50+ queries. Replaced with a single query using Prisma include with _count. Added composite index on (authorId, publishedAt).', filesTouched: ['src/posts/queries.ts'] },
    { promptIndex: 20, userMessage: 'Add database backup script with pg_dump', assistantResponse: 'Created backup.sh that runs pg_dump with custom format, compresses with gzip, and uploads to S3. Added cron schedule for daily 3am backups.' },
    { promptIndex: 21, userMessage: 'Set up database monitoring with pg_stat_statements', assistantResponse: 'Enabled pg_stat_statements extension. Created a Grafana dashboard showing top queries by time, calls, and rows. Alert on queries exceeding 500ms.' },

    // --- Cache topic: DB query cache (turn 22) ---
    { promptIndex: 22, userMessage: 'Add query result caching for the expensive analytics dashboard queries', assistantResponse: 'Cached the analytics aggregation queries in Redis with 5-minute TTL. Used a hash of the query parameters as the cache key. Dashboard load time dropped from 3.2s to 180ms on cache hit.' },

    // --- State management cluster (turns 23-29): "session" keyword bleeds ---
    { promptIndex: 23, userMessage: 'Set up Redux store with TypeScript', assistantResponse: 'Created Redux store with configureStore. Added proper TypeScript types for RootState and AppDispatch. Configured Redux DevTools.' },
    { promptIndex: 24, userMessage: 'Create the notifications slice', assistantResponse: 'Created notificationsSlice with actions: addNotification, dismissNotification, clearAll. Queue system with max 5 visible at a time.' },
    { promptIndex: 25, userMessage: 'Add session state management for tracking user navigation flow', assistantResponse: 'Created sessionSlice in the Redux store for tracking user navigation state. Stores the current page, breadcrumb history, sidebar collapsed state, and last visited timestamp. The session state persists to localStorage on beforeunload.', filesTouched: ['src/store/session-slice.ts'] },
    { promptIndex: 26, userMessage: 'Implement optimistic updates for the todo list', assistantResponse: 'Added optimistic update pattern for todo CRUD. On mutation, we immediately update the store and show the change, then reconcile with the server response. On failure, revert with the original value and show error toast.' },
    { promptIndex: 27, userMessage: 'Add undo/redo support for the editor state', assistantResponse: 'Implemented undo/redo using an action history stack. Each undoable action pushes to the past array. Undo pops from past to future. Limited to 50 entries to prevent memory bloat.' },
    { promptIndex: 28, userMessage: 'Fix the session state persistence race condition', assistantResponse: 'The session state in Redux was being saved to localStorage during the beforeunload event, but the async thunk was being cancelled. Fixed by using synchronous localStorage.setItem directly in a store subscriber instead of a thunk.', filesTouched: ['src/store/session-slice.ts', 'src/store/persistence.ts'] },
    { promptIndex: 29, userMessage: 'Add middleware for logging state transitions in development', assistantResponse: 'Created a custom Redux middleware that logs prev state, action type + payload, and next state in development mode. Filtered out high-frequency actions like mouse move.' },

    // --- Redis cache cluster (turns 30-34): "cache" keyword ---
    { promptIndex: 30, userMessage: 'Set up Redis cluster for production caching', assistantResponse: 'Configured ioredis with Redis Cluster mode. 3 master nodes with 1 replica each. Set up automatic failover with Sentinel. Connection pooling with min 5, max 20 connections per node.', filesTouched: ['src/cache/redis-cluster.ts'] },
    { promptIndex: 31, userMessage: 'Implement cache invalidation strategy for Redis', assistantResponse: 'Built a tag-based cache invalidation system for Redis. Each cached entry is tagged with entity types (e.g., "user:123", "post:456"). On write operations, we invalidate all entries matching the affected tags. Used Redis Sets to track tag-to-key mappings.', filesTouched: ['src/cache/invalidation.ts'] },
    { promptIndex: 32, userMessage: 'go ahead', assistantResponse: 'Applied the tag-based invalidation to the posts and comments endpoints. Write operations now automatically invalidate the relevant cache entries. Added metrics tracking for cache hit rate.' },
    { promptIndex: 33, userMessage: 'Add cache warming on application startup', assistantResponse: 'Created a cache warming script that pre-populates Redis with the most frequently accessed data: top 100 posts, active user sessions, and configuration values. Runs as a post-deploy hook.', filesTouched: ['src/cache/warming.ts'] },
    { promptIndex: 34, userMessage: 'Set up Redis cache monitoring with hit/miss ratio alerts', assistantResponse: 'Added Prometheus metrics for Redis cache: hit rate, miss rate, eviction count, memory usage. Alert when hit rate drops below 80% sustained for 5 minutes. Grafana dashboard with time-series charts.' },

    // --- Filler (turns 35-39) ---
    { promptIndex: 35, userMessage: 'Add WebSocket support for real-time notifications', assistantResponse: 'Set up Socket.IO server with authentication middleware. Clients connect with JWT and join user-specific rooms. Server broadcasts notification events.' },
    { promptIndex: 36, userMessage: 'Create the file upload service with S3', assistantResponse: 'Built multipart upload handler using multer + AWS SDK v3. Files go to S3 with presigned URLs for download. Added virus scanning with ClamAV before S3 upload.' },
    { promptIndex: 37, userMessage: 'Add rate limiting to all API endpoints', assistantResponse: 'Configured express-rate-limit with sliding window. Default: 100 req/15min. Auth endpoints: 5 req/15min. Upload: 10 req/hour. Returns Retry-After header.' },
    { promptIndex: 38, userMessage: 'Implement request validation with zod schemas', assistantResponse: 'Created zod schemas for all API request bodies. Added validateRequest middleware that parses and validates before reaching the handler. Returns structured 400 errors with field-level messages.' },
    { promptIndex: 39, userMessage: 'Add API versioning with URL prefix', assistantResponse: 'Set up /api/v1/ prefix routing. Created version negotiation middleware that falls back gracefully. Added deprecation headers for v1 endpoints slated for removal.' },

    // --- Browser cache (turn 40): "cache" bleeds ---
    { promptIndex: 40, userMessage: 'Configure browser caching headers for static assets', assistantResponse: 'Set Cache-Control headers: static assets (JS/CSS/images) get max-age=31536000 with content-hash filenames. HTML gets no-cache with ETag. API responses get no-store. Added Vary: Accept-Encoding for CDN compatibility.' },

    // --- Filler (turns 41-44) ---
    { promptIndex: 41, userMessage: 'Add GraphQL API alongside REST', assistantResponse: 'Set up Apollo Server with type-defs generated from Prisma schema. Created resolvers for User, Post, Comment types. Added DataLoader for batching N+1 queries.' },
    { promptIndex: 42, userMessage: 'Implement pagination for the GraphQL queries', assistantResponse: 'Added cursor-based pagination following the Relay spec. Implemented Connection types with edges, nodes, and pageInfo. Default page size 20, max 100.' },
    { promptIndex: 43, userMessage: 'Add error tracking with Sentry', assistantResponse: 'Integrated Sentry SDK with Express. Configured source maps upload in CI. Added breadcrumbs for database queries and HTTP requests. Set up alert rules for error rate spikes.' },
    { promptIndex: 44, userMessage: 'Create health check endpoint with dependency status', assistantResponse: 'Extended /health to check database, Redis, and S3 connectivity. Returns 200 if all healthy, 503 if any dependency is down. Added /health/ready for Kubernetes readiness probe.' },

    // --- Testing cluster (turns 45-49): "session" bleeds ---
    { promptIndex: 45, userMessage: 'Set up integration test infrastructure with test database', assistantResponse: 'Created test setup with isolated PostgreSQL database. Each test file gets a fresh schema via Prisma migrate. Test session fixtures provide pre-authenticated HTTP clients. Added global setup/teardown.', filesTouched: ['src/__tests__/setup.ts'] },
    { promptIndex: 46, userMessage: 'Write integration tests for the posts API', assistantResponse: 'Created tests for CRUD operations on posts: create returns 201, list returns paginated results, update only allowed by author, delete cascades to comments. Used supertest with authenticated sessions.' },
    { promptIndex: 47, userMessage: 'Add load testing with k6', assistantResponse: 'Created k6 load test scripts. Scenarios: constant 100 VUs for 5min (baseline), ramp to 500 VUs (stress), spike to 1000 VUs (spike). Thresholds: p95 < 500ms, error rate < 1%.' },
    { promptIndex: 48, userMessage: 'Fix the test session cleanup that was leaking database connections', assistantResponse: 'The test session cleanup was not closing Prisma connections in afterAll. This caused connection pool exhaustion after ~20 test files. Fixed by adding explicit prisma.$disconnect() in global teardown and per-file afterAll hooks.', filesTouched: ['src/__tests__/setup.ts', 'src/__tests__/teardown.ts'] },
    { promptIndex: 49, userMessage: 'Add code coverage reporting with Istanbul', assistantResponse: 'Configured Istanbul/nyc for coverage collection. Set thresholds: 80% branches, 85% lines, 80% functions. Added coverage badge to README. CI fails if thresholds not met.' },

    // --- Filler (turns 50-54) ---
    { promptIndex: 50, userMessage: 'Set up Docker compose for local development', assistantResponse: 'Created docker-compose.yml with app, PostgreSQL, Redis, and pgAdmin services. Added volume mounts for hot reload. Health checks on all services.' },
    { promptIndex: 51, userMessage: 'Add CI/CD pipeline with GitHub Actions', assistantResponse: 'Created workflow: lint, typecheck, test (with PostgreSQL service), build, deploy to staging. Added caching for node_modules and Prisma client. Parallel jobs for lint+typecheck.' },
    { promptIndex: 52, userMessage: 'Set up staging environment on AWS ECS', assistantResponse: 'Created ECS Fargate task definition with 512 CPU, 1024 MB memory. ALB with health check. RDS PostgreSQL and ElastiCache Redis. Auto-scaling based on CPU utilization.' },
    { promptIndex: 53, userMessage: 'Add structured logging with winston', assistantResponse: 'Replaced console.log with winston. JSON format in production, colorized in development. Log levels from env. Added request correlation ID that flows through all log entries.' },
    { promptIndex: 54, userMessage: 'Implement graceful shutdown for the Express server', assistantResponse: 'Added SIGTERM/SIGINT handlers that stop accepting new connections, wait for in-flight requests (30s timeout), close database pool, disconnect Redis, then exit 0.' },

    // --- Auth cluster 2 (turns 55-62): temporal disambiguation ---
    { promptIndex: 55, userMessage: 'The authentication is broken after the latest deployment', assistantResponse: 'Found the issue — the JWT_SECRET environment variable was not set in the new ECS task definition. The auth middleware was failing silently and returning 500 instead of proper 401.', filesTouched: ['src/auth/middleware.ts'] },
    { promptIndex: 56, userMessage: 'Add multi-factor authentication with TOTP', assistantResponse: 'Implemented TOTP-based 2FA using speakeasy. Users can enable 2FA from settings, scan QR code with authenticator app. Login now requires the TOTP code when 2FA is enabled. Added backup codes.', filesTouched: ['src/auth/totp.ts', 'src/auth/login.ts'] },
    { promptIndex: 57, userMessage: 'Fix the auth token refresh race condition on concurrent requests', assistantResponse: 'When multiple API calls fire simultaneously with an expired access token, they all try to refresh at once. Only the first should refresh; others should wait. Added a mutex/queue pattern in the refresh endpoint using Redis SETNX as a distributed lock.', filesTouched: ['src/auth/refresh.ts'] },
    { promptIndex: 58, userMessage: 'Add audit logging for all authentication events', assistantResponse: 'Created an auth_events table logging: login, logout, token_refresh, password_change, 2fa_enable, 2fa_disable, failed_login. Each entry has userId, IP, user agent, timestamp, and event metadata.', filesTouched: ['src/auth/audit.ts', 'prisma/schema.prisma'] },
    { promptIndex: 59, userMessage: 'Implement account lockout after failed login attempts', assistantResponse: 'After 5 consecutive failed logins, the account is locked for 30 minutes. Used Redis with TTL to track attempts per user. Sends email notification on lockout. Admin can unlock manually via dashboard.' },
    { promptIndex: 60, userMessage: 'Add password complexity requirements and breach detection', assistantResponse: 'Implemented password policy: min 12 chars, uppercase, lowercase, number, special char. Added Have I Been Pwned API check via k-anonymity (first 5 SHA1 chars). Reject if password appears in known breaches.' },
    { promptIndex: 61, userMessage: 'Fix the session token leak in error responses', assistantResponse: 'The error handler was including the full request object in 500 error logs, which contained the Authorization header. Sanitized the error serializer to strip auth headers, cookies, and other sensitive fields.', filesTouched: ['src/auth/error-handler.ts'] },
    { promptIndex: 62, userMessage: 'Add API key authentication for service-to-service calls', assistantResponse: 'Created API key management: generate, revoke, list keys. Keys are hashed with SHA256 before storage. Auth middleware checks X-API-Key header first, then falls back to JWT. Rate limits are per-key.', filesTouched: ['src/auth/api-keys.ts'] },

    // --- Filler (turns 63-71) ---
    { promptIndex: 63, userMessage: 'Add internationalization support with i18next', assistantResponse: 'Set up i18next with JSON resource files. Middleware detects locale from Accept-Language header. Responses use translated messages. Added pluralization rules for en, es, fr, de.' },
    { promptIndex: 64, userMessage: 'Create admin dashboard with user management', assistantResponse: 'Built admin dashboard with user listing (search, filter, paginate), user detail view (edit role, lock/unlock, view audit log), and system statistics.' },
    { promptIndex: 65, userMessage: 'Add email sending with SendGrid', assistantResponse: 'Integrated SendGrid for transactional emails. Template-based: welcome, password reset, account locked, 2FA enabled. Queue via Bull for reliability.' },
    { promptIndex: 66, userMessage: 'Implement webhook delivery system', assistantResponse: 'Created webhook management: register URLs, select events, verify signatures. Delivery with exponential backoff retry (1m, 5m, 30m, 2h). Dead letter queue after 5 failures.' },
    { promptIndex: 67, userMessage: 'Add request tracing with OpenTelemetry', assistantResponse: 'Integrated OpenTelemetry with Jaeger backend. Auto-instrumentation for Express, Prisma, and ioredis. Custom spans for business logic. Trace ID propagation in headers.' },
    { promptIndex: 68, userMessage: 'Create the data export API for GDPR compliance', assistantResponse: 'Built /me/export endpoint that compiles all user data: profile, posts, comments, auth logs, preferences. Returns as ZIP with JSON files. Queued via Bull for large exports.' },
    { promptIndex: 69, userMessage: 'Add feature flags with LaunchDarkly', assistantResponse: 'Integrated LaunchDarkly SDK. Wrapped feature checks in a FeatureGate middleware. Client-side flags via SSR bootstrap. Added targeting rules for gradual rollouts.' },
    { promptIndex: 70, userMessage: 'Implement content moderation for user posts', assistantResponse: 'Added Perspective API integration for toxicity scoring. Posts above threshold go to moderation queue. Admin review UI with approve/reject/edit. Auto-flag repeated offenders.' },
    { promptIndex: 71, userMessage: 'Add image optimization pipeline', assistantResponse: 'Built Sharp-based image processing: resize to multiple breakpoints (320, 640, 1024, 1920), convert to WebP and AVIF, strip EXIF. Processed on upload, originals kept in S3.' },

    // --- Deployment with "session" bleed (turn 72) ---
    { promptIndex: 72, userMessage: 'Configure sticky sessions for the WebSocket deployment behind the load balancer', assistantResponse: 'Configured ALB sticky sessions using application cookie (AWSALB). WebSocket connections now route to the same ECS task. Added connection draining with 300s timeout for deployments. Socket.IO configured with transports: [websocket] to skip long-polling.' },

    // --- Remaining filler (turns 73-99) ---
    { promptIndex: 73, userMessage: 'Add database query performance monitoring', assistantResponse: 'Created Prisma middleware that logs slow queries (>100ms). Sends metrics to Datadog. Added weekly report of top 10 slowest queries with execution plans.' },
    { promptIndex: 74, userMessage: 'Implement soft delete for posts and comments', assistantResponse: 'Added deletedAt column to posts and comments. Updated queries to filter deleted records. Admin can view and restore deleted content. Hard delete after 30 days via cron.' },
    { promptIndex: 75, userMessage: 'Add content versioning for posts', assistantResponse: 'Created post_versions table tracking all edits. Each save creates a new version. Diff view in editor. Restore to any previous version.' },
    { promptIndex: 76, userMessage: 'Set up blue-green deployment strategy', assistantResponse: 'Configured ECS with blue-green deployment via CodeDeploy. Health check validation before traffic shift. Automatic rollback on alarm. Zero-downtime deployments.' },
    { promptIndex: 77, userMessage: 'Add data anonymization for the staging environment', assistantResponse: 'Created script that copies prod to staging with anonymized PII: emails become user_N@example.com, names from faker, addresses randomized. Preserves relational integrity.' },
    { promptIndex: 78, userMessage: 'Implement bulk import for posts via CSV', assistantResponse: 'Built CSV import endpoint with streaming parser. Validates each row against schema. Processes in batches of 100 with transaction. Reports errors per row without failing the whole import.' },
    { promptIndex: 79, userMessage: 'Add database read replicas for reporting queries', assistantResponse: 'Configured Prisma with separate read connection for analytics/reporting. Replication lag monitoring with alert at >5s. Automatic failover to primary if replica is down.' },
    { promptIndex: 80, userMessage: 'Create API documentation with OpenAPI/Swagger', assistantResponse: 'Generated OpenAPI 3.0 spec from route definitions. Swagger UI at /docs. Added request/response examples. Authentication documented with security schemes.' },
    { promptIndex: 81, userMessage: 'Add server-sent events for live dashboard updates', assistantResponse: 'Implemented SSE endpoint for real-time dashboard. Clients subscribe to metric streams. Server pushes updates every 5s. Automatic reconnection with Last-Event-ID.' },
    { promptIndex: 82, userMessage: 'Implement data archival for old posts', assistantResponse: 'Created archival job that moves posts older than 2 years to archive table. Partitioned by year. Archived posts still searchable via separate index. Reduced main table size by 60%.' },
    { promptIndex: 83, userMessage: 'Add A/B testing framework', assistantResponse: 'Built experiment framework: define variants with weights, assign users deterministically by hash. Track conversion events. Statistical significance calculator. Results dashboard.' },
    { promptIndex: 84, userMessage: 'Create the notification preferences system', assistantResponse: 'Users can configure per-channel (email, push, in-app) preferences for each notification type. Default preferences by role. Batch digest option for email (immediate, daily, weekly).' },
    { promptIndex: 85, userMessage: 'Add DNS-based service discovery', assistantResponse: 'Configured AWS Cloud Map for service discovery. Services register on startup. Health checks via Route53. DNS TTL of 10s for fast failover.' },
    { promptIndex: 86, userMessage: 'Implement circuit breaker for external API calls', assistantResponse: 'Added opossum circuit breaker for external APIs (SendGrid, Perspective, S3). Open after 5 failures in 30s. Half-open after 60s. Fallback responses for degraded mode.' },
    { promptIndex: 87, userMessage: 'Add database connection retry logic', assistantResponse: 'Implemented exponential backoff retry for database connections: 1s, 2s, 4s, 8s, max 30s. Max 10 retries. Applies to initial connection and transient errors. Jitter to prevent thundering herd.' },
    { promptIndex: 88, userMessage: 'Create the user onboarding flow', assistantResponse: 'Built multi-step onboarding: profile completion, preferences setup, tutorial walkthrough. Progress tracked in user_onboarding table. Skip option available. Re-trigger from settings.' },
    { promptIndex: 89, userMessage: 'Add response compression with gzip/brotli', assistantResponse: 'Configured compression middleware with Brotli (quality 4) preferred, gzip fallback. Skip for responses < 1KB. Reduced average response size by 72%.' },
    { promptIndex: 90, userMessage: 'Implement request deduplication for idempotent endpoints', assistantResponse: 'Added Idempotency-Key header support for POST/PUT. Keys stored in Redis with 24h TTL. Duplicate requests return cached response. Prevents double-submit issues.' },
    { promptIndex: 91, userMessage: 'Add memory leak detection to the monitoring stack', assistantResponse: 'Integrated clinic.js for heap profiling. Added /debug/heap endpoint (admin only). Prometheus metrics for heap used/total. Alert on sustained growth >10MB/hour.' },
    { promptIndex: 92, userMessage: 'Create the search autocomplete API', assistantResponse: 'Built prefix search using PostgreSQL trigram index. Returns top 10 suggestions with highlighting. Debounced on client side. Added popular searches boost.' },
    { promptIndex: 93, userMessage: 'Add CORS configuration for multiple frontend origins', assistantResponse: 'Configured CORS with allowlist of origins from environment. Supports credentials for cookie-based auth. Preflight caching at 1 hour. Different policies for API vs WebSocket.' },
    { promptIndex: 94, userMessage: 'Implement job queue with Bull for background processing', assistantResponse: 'Set up Bull queues: email-sending, image-processing, data-export, cache-warming. Dashboard UI at /admin/queues. Retry with backoff. Dead letter queue for failed jobs.' },
    { promptIndex: 95, userMessage: 'Add end-to-end encryption for sensitive user data', assistantResponse: 'Implemented AES-256-GCM encryption for PII fields: phone, address, SSN. Keys managed via AWS KMS. Automatic encryption on write, decryption on read. Key rotation every 90 days.' },
    { promptIndex: 96, userMessage: 'Create the billing and subscription system', assistantResponse: 'Integrated Stripe for subscriptions. Plans: free, pro, enterprise. Usage-based billing for API calls. Webhook handlers for payment events. Invoice generation and receipt emails.' },
    { promptIndex: 97, userMessage: 'Add canary deployment support', assistantResponse: 'Extended CodeDeploy config for canary: 10% traffic for 10min, then full rollout. CloudWatch alarm on error rate and latency. Automatic rollback if alarm triggers.' },
    { promptIndex: 98, userMessage: 'Implement GraphQL subscriptions for real-time updates', assistantResponse: 'Added GraphQL subscriptions via WebSocket transport. PubSub backed by Redis. Subscriptions for: postCreated, commentAdded, notificationReceived. Auth required for subscription.' },
    { promptIndex: 99, userMessage: 'Final review and cleanup of the codebase', assistantResponse: 'Ran full lint, removed unused imports, updated dependencies. Fixed 3 security advisories. Updated README with architecture diagram and API reference links.' },
  ];

  return specs.map(spec => makeTurn({
    promptIndex: spec.promptIndex,
    userMessage: spec.userMessage,
    assistantResponse: spec.assistantResponse,
    filesTouched: spec.filesTouched ?? [],
  }));
}
