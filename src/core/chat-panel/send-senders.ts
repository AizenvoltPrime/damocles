// A panel several views show (a daemon's clients): what core gives back from a send (the message returned to the composer, a
// queued message put back, the settings a refusal opens) reaches the view that sent it alone, and a returned send that
// combined queued messages gives each its own view's composer; every view still sees the rest.
import type { PanelHost } from "../../platform/window-service";
import type { ExtensionToWebviewMessage, QueuedPart } from "../../shared/types/messages";
import type { UserContentBlock } from "../../shared/types/content";

interface Senders {
  // a send's correlation id or a queued message's id -> the view key of the view that sent it
  readonly byId: Map<string, string>;
  // the views a give-back of this tick goes to: a queued batch's senders, then a refusal's settings
  current: readonly string[] | undefined;
  // the send that combined queued messages (core runs one send at a time): each message's id -> the view that queued it
  batch: { readonly sentAs: string; readonly byId: Map<string, string> } | undefined;
}

const byPanel = new WeakMap<PanelHost, Senders>();
// a send pi ran as an extension command commits no prompt and is never named again, so the oldest entries make room
const MAX_SENDERS = 256;

function sendersOf(panel: PanelHost): Senders {
  let senders = byPanel.get(panel);
  if (!senders) {
    senders = { byId: new Map(), current: undefined, batch: undefined };
    byPanel.set(panel, senders);
  }
  return senders;
}

// queued messages as one composer's content, joined as core joins a batch: text alone stays one text block
function joinedContent(contents: readonly UserContentBlock[][]): UserContentBlock[] {
  const blocks = contents.flat();
  if (!blocks.every((block) => block.type === "text")) return blocks;
  return blocks.length === 0 ? [] : [{ type: "text", text: blocks.map((block) => block.text).join("\n\n") }];
}

// what one give-back names goes to these views for the rest of the tick, which is how core emits a give-back's parts
function holdForTick(senders: Senders, keys: readonly string[]): void {
  const held = [...new Set([...(senders.current ?? []), ...keys])];
  senders.current = held;
  queueMicrotask(() => {
    if (senders.current === held) senders.current = undefined;
  });
}

/** A send or queued message from one view of several: its give-back goes to that view. panel: the panel's own host. */
export function recordSender(panel: PanelHost, viewKey: string | undefined, id: string): void {
  if (panel.viewHost === undefined || viewKey === undefined) return;
  const { byId } = sendersOf(panel);
  byId.set(id, viewKey);
  for (const oldest of byId.keys()) {
    if (byId.size <= MAX_SENDERS) break;
    byId.delete(oldest);
  }
}

/** A send or queued message that ended with nothing more to give back: no message of the session names it again. */
export function forgetSender(panel: PanelHost, id: string): void {
  byPanel.get(panel)?.byId.delete(id);
}

/** Posts a message the panel's session emitted: a give-back to its sender's view, everything else to every view. */
export function postToSenders(panel: PanelHost, message: ExtensionToWebviewMessage, post: (host: PanelHost, message: ExtensionToWebviewMessage, except?: readonly string[]) => void): void {
  const senders = byPanel.get(panel);
  if (!senders || !panel.viewHost) {
    post(panel, message);
    return;
  }
  const take = (id: string): string | undefined => {
    const key = senders.byId.get(id);
    senders.byId.delete(id);
    return key;
  };
  const toViews = (keys: readonly string[]): void => {
    for (const key of keys) post(panel.viewHost!(key), message);
  };
  // each queued message of a combined send back to the view that queued it, one whose view is unknown to every view; a view
  // that queued none gets the give-back with no content, which only drops the send's echo
  const returnParts = (parts: readonly QueuedPart[], build: (content: UserContentBlock[]) => ExtensionToWebviewMessage): void => {
    const batch = senders.batch;
    senders.batch = undefined;
    const byView = new Map<string | undefined, UserContentBlock[][]>();
    for (const part of parts) {
      const key = batch?.byId.get(part.messageId);
      byView.set(key, [...(byView.get(key) ?? []), part.content]);
    }
    const keys = [...byView.keys()].filter((key): key is string => key !== undefined);
    holdForTick(senders, keys);
    for (const key of keys) post(panel.viewHost!(key), build(joinedContent(byView.get(key)!)));
    post(panel, build(joinedContent(byView.get(undefined) ?? [])), keys);
  };
  const ofBatch = (correlationId: string | undefined): boolean => correlationId !== undefined && senders.batch?.sentAs === correlationId;
  switch (message.type) {
    case "userMessageIdAssigned":
      // the send committed: nothing comes back for it
      take(message.correlationId);
      if (ofBatch(message.correlationId)) senders.batch = undefined;
      post(panel, message);
      return;
    case "queueProcessed":
      take(message.messageId);
      post(panel, message);
      return;
    case "queueBatchProcessed":
      message.messageIds.forEach(take);
      post(panel, message);
      return;
    case "queueCancelled": {
      const key = take(message.messageId);
      if (message.sentAs !== undefined) {
        // its text went into a send of several, which may still come back
        if (senders.batch?.sentAs !== message.sentAs) senders.batch = { sentAs: message.sentAs, byId: new Map() };
        if (key !== undefined) senders.batch.byId.set(message.messageId, key);
        post(panel, message);
        return;
      }
      if (key === undefined || message.returnToInput !== true) {
        if (key !== undefined) holdForTick(senders, [key]);
        post(panel, message);
        return;
      }
      // the chip goes from every view, and its text back to the composer of the view that queued it
      holdForTick(senders, [key]);
      post(panel.viewHost(key), message);
      post(panel, { type: "queueCancelled", messageId: message.messageId }, [key]);
      return;
    }
    case "promptReturned": {
      const { parts, ...returned } = message;
      if (parts !== undefined && ofBatch(message.correlationId)) {
        returnParts(parts, (content) => ({ ...returned, content }));
        return;
      }
      const key = message.correlationId === undefined ? undefined : take(message.correlationId);
      const keys = key !== undefined ? [key] : senders.current;
      if (keys === undefined || keys.length === 0) {
        post(panel, message);
        return;
      }
      holdForTick(senders, keys);
      toViews(keys);
      // the other views showed the send's echo, which the give-back with no content drops
      if (message.correlationId !== undefined) post(panel, { ...returned, content: [] }, keys);
      return;
    }
    case "interruptRecovery": {
      const { parts, correlationId } = message;
      if (parts === undefined || !ofBatch(correlationId)) {
        const key = take(correlationId);
        if (key === undefined) {
          post(panel, message);
          return;
        }
        post(panel.viewHost(key), message);
        post(panel, { type: "interruptRecovery", correlationId, promptContent: "" }, [key]);
        return;
      }
      returnParts(parts, (content) => ({
        type: "interruptRecovery",
        correlationId,
        promptContent: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n"),
        ...(content.some((block) => block.type !== "text") ? { contentBlocks: content } : {}),
      }));
      return;
    }
    case "openSettingsPanel":
      if (senders.current === undefined) post(panel, message);
      else toViews(senders.current);
      return;
    default:
      post(panel, message);
  }
}
