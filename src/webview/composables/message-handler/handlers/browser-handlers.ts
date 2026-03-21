import type { HandlerRegistry } from '../types';
import { elementAttachmentBus } from '@/composables/useElementAttachments';

export function createBrowserHandlers(): Partial<HandlerRegistry> {
  return {
    browserElementPicked: (msg) => {
      elementAttachmentBus.emit(msg.element);
    },
  };
}
