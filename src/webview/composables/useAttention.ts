import { nextTick, onBeforeUnmount, onMounted, toValue, type MaybeRefOrGetter } from 'vue';
import type { AttentionKind } from '@shared/types/messages';
import { focusDockPrompt } from '@/composables/useDockPrompt';

/** What a mounted dock card answers; `input` (a form or an MCP elicitation) answers a question's attention. */
export type AttentionCardKind = 'approval' | 'question' | 'input';

type CardAttentionKind = Exclude<AttentionKind, 'plan'>;

const CARDS_FOR: Record<CardAttentionKind, readonly AttentionCardKind[]> = {
  approval: ['approval'],
  question: ['question', 'input'],
};

// A prompt's card that mounts later than this (an async prompt component still loading) belongs to a newer prompt.
const ATTENTION_WAIT_MS = 2000;

interface AttentionCard {
  kind: AttentionCardKind;
  element: () => HTMLElement | null | undefined;
}

const cards: AttentionCard[] = [];
let waiting: { kind: CardAttentionKind; until: number } | null = null;

/** Plays the attention ring (`d-attention` in motion.css) on `element` from its start. */
export function playAttention(element: HTMLElement): void {
  element.classList.remove('d-attention');
  // Reading layout here makes the browser drop the old animation, so the class added next starts it over.
  void element.offsetWidth;
  element.classList.add('d-attention');
  const done = (event: AnimationEvent): void => {
    if (event.animationName !== 'd-attention-ring') return;
    element.classList.remove('d-attention');
    element.removeEventListener('animationend', done);
  };
  element.addEventListener('animationend', done);
}

function attend(card: AttentionCard): boolean {
  const element = card.element();
  if (!element?.isConnected) return false;
  focusDockPrompt(element);
  playAttention(element);
  return true;
}

/** Registers a dock card for `requestAttention`; a request made while it was still mounting reaches it. */
export function useAttentionCard(kind: AttentionCardKind, element: MaybeRefOrGetter<HTMLElement | null | undefined>): void {
  const card: AttentionCard = { kind, element: () => toValue(element) };
  onMounted(() => {
    cards.push(card);
    if (!waiting || !CARDS_FOR[waiting.kind].includes(kind) || performance.now() > waiting.until) return;
    waiting = null;
    void nextTick(() => attend(card));
  });
  onBeforeUnmount(() => {
    const index = cards.indexOf(card);
    if (index !== -1) cards.splice(index, 1);
  });
}

/**
 * The user chose a notification's action for this chat: focus the card of `kind` (a question's falls back to an
 * input) and play its ring. `pending` says the stores hold such a prompt, whose card may still be mounting; a
 * request that finds no card and no prompt does nothing.
 */
export function requestAttention(kind: CardAttentionKind, pending: boolean): void {
  waiting = null;
  if (attendFirst(kind) || !pending) return;
  const request = { kind, until: performance.now() + ATTENTION_WAIT_MS };
  waiting = request;
  // A prompt that arrived just before the request renders its card on the next tick.
  void nextTick(() => {
    if (waiting === request && attendFirst(kind)) waiting = null;
  });
}

function attendFirst(kind: CardAttentionKind): boolean {
  for (const cardKind of CARDS_FOR[kind]) {
    const card = cards.find((candidate) => candidate.kind === cardKind && candidate.element()?.isConnected);
    if (card && attend(card)) return true;
  }
  return false;
}
