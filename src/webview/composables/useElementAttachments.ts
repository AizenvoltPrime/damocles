import { ref, computed } from 'vue';
import type { UserContentBlock } from '@shared/types/content';
import type { ElementAttachment } from '@shared/types/browser';

const MAX_ELEMENT_ATTACHMENTS = 5;

type ElementListener = (element: ElementAttachment) => void;
const listeners: ElementListener[] = [];

export const elementAttachmentBus = {
  emit(element: ElementAttachment): void {
    for (const fn of listeners) fn(element);
  },
  on(fn: ElementListener): () => void {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  },
};

export function useElementAttachments() {
  const attachments = ref<ElementAttachment[]>([]);

  const hasAttachments = computed(() => attachments.value.length > 0);
  const canAddMore = computed(() => attachments.value.length < MAX_ELEMENT_ATTACHMENTS);

  function add(element: ElementAttachment): boolean {
    if (!canAddMore.value) return false;
    if (attachments.value.some(a => a.id === element.id)) return false;
    attachments.value.push(element);
    return true;
  }

  function remove(id: string): void {
    const index = attachments.value.findIndex(a => a.id === id);
    if (index !== -1) {
      attachments.value.splice(index, 1);
    }
  }

  function clear(): void {
    attachments.value = [];
  }

  function toContentBlocks(): UserContentBlock[] {
    return attachments.value.flatMap(el => {
      const blocks: UserContentBlock[] = [
        { type: 'text', text: formatElementContext(el) },
      ];
      if (el.elementScreenshot) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: el.elementScreenshot },
        });
      }
      return blocks;
    });
  }

  return {
    attachments,
    hasAttachments,
    canAddMore,
    add,
    remove,
    clear,
    toContentBlocks,
  };
}

export function formatElementContext(el: ElementAttachment): string {
  const lines: string[] = [
    `<element-context>`,
    `Element: ${el.selector}`,
  ];

  if (el.htmlPath) {
    lines.push(``, `HTML Path:`, el.htmlPath);
  }

  if (Object.keys(el.attributes).length > 0) {
    lines.push(``, `Attributes:`);
    for (const [key, value] of Object.entries(el.attributes)) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  lines.push(
    ``,
    `Dimensions: ${Math.round(el.boundingBox.width)}x${Math.round(el.boundingBox.height)} at (${Math.round(el.boundingBox.x)}, ${Math.round(el.boundingBox.y)})`,
  );

  if (Object.keys(el.computedStyles).length > 0) {
    lines.push(``, `Computed Styles:`);
    for (const [prop, value] of Object.entries(el.computedStyles)) {
      lines.push(`- ${prop}: ${value}`);
    }
  }

  if (el.matchedRules) {
    lines.push(``, `Matched CSS Rules:`, el.matchedRules);
  }

  if (el.innerText) {
    lines.push(``, `Inner Text:`, el.innerText);
  }

  lines.push(``, `HTML:`, el.outerHTML);

  if (el.consoleMessages.length > 0) {
    lines.push(``, `Console Messages (${el.consoleMessages.length}):`);
    for (const msg of el.consoleMessages.slice(-10)) {
      lines.push(`  [${msg.level}] ${msg.text}`);
    }
  }

  if (el.networkErrors.length > 0) {
    lines.push(``, `Network Errors (${el.networkErrors.length}):`);
    for (const err of el.networkErrors.slice(-10)) {
      lines.push(`  ${err.status ?? 'ERR'} ${err.url}`);
    }
  }

  lines.push(`</element-context>`);
  return lines.join('\n');
}
