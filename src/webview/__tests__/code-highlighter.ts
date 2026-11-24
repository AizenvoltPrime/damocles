import { CODE_HIGHLIGHTER } from '@/composables/code-highlighter';
import { SHIKI_HIGHLIGHTER } from '@/composables/useShikiHighlighter';

/** What the chat view's app (chat-app.ts) provides, for the code blocks and diffs a test mounts without it. */
export const CHAT_VIEW_PROVIDE = { [CODE_HIGHLIGHTER as symbol]: SHIKI_HIGHLIGHTER };
