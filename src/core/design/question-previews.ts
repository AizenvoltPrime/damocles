// Design-kind question previews (PD-18, FULL): an option's screen captured at the design's primary width through the
// attached client, kept in a small cache keyed by the folder's content hash and the width. The image goes to the asking
// webview only, never into a message of the session.
import { createHash } from 'node:crypto';
import type { DesignPreviewHost } from '../../platform/design-preview';
import { MAX_RENDER_SCALE, pngSize } from '../../shared/design-render';
import { LocalizedError } from '../../shared/localized-text';
import { TOOL_ASK_USER_QUESTION } from '../../shared/tool-names';
import type { DesignPreviewImage } from '../../shared/types/design';
import { l } from '../l10n';
import { designContentHash } from './design-files';
import { isDesignPreviewPath } from './design-paths';
import { designPreviewInfo } from './design-preview';
import { DesignRenderUnavailableError, rendered } from './width-checks';

const MAX_CACHED_IMAGES = 32;
const MAX_CACHED_CHARS = 48 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The questions of AskUserQuestion call `toolUseId` as the branch's assistant message holds them. */
export function askedQuestions(branch: readonly unknown[], toolUseId: string): unknown {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!isRecord(entry) || entry['type'] !== 'message' || !isRecord(entry['message']) || entry['message']['role'] !== 'assistant') continue;
    const content = entry['message']['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isRecord(block) && block['type'] === 'toolCall' && block['id'] === toolUseId && block['name'] === TOOL_ASK_USER_QUESTION && isRecord(block['arguments'])) return block['arguments']['questions'];
    }
  }
  return undefined;
}

/** The design-kind preview path of one option of `questions`, under QuestionManager's rule, else undefined. */
export function designPreviewPathOf(questions: unknown, questionIndex: number, optionIndex: number): string | undefined {
  if (!Array.isArray(questions)) return undefined;
  const question: unknown = questions[questionIndex];
  const options = isRecord(question) ? question['options'] : undefined;
  const option: unknown = Array.isArray(options) ? options[optionIndex] : undefined;
  const preview = isRecord(option) ? option['preview'] : undefined;
  const path = isRecord(preview) && preview['kind'] === 'design' ? preview['path'] : undefined;
  return typeof path === 'string' && isDesignPreviewPath(path) ? path : undefined;
}

/** A least recently used cache of captures, bounded in entries and characters; one capture runs per key at a time. */
export class DesignPreviewImages {
  private readonly images = new Map<string, Promise<DesignPreviewImage>>();
  private readonly sizes = new Map<string, number>();

  /** Screen `relPath` of design `designId` (folder `folder`) at its primary width, from the cache or captured now. */
  async image(render: DesignPreviewHost, designId: string, folder: string, relPath: string, signal: AbortSignal): Promise<DesignPreviewImage> {
    const info = await designPreviewInfo(folder, relPath);
    if (!info) throw new LocalizedError(l('{0} is not a screen of this design.', relPath));
    const key = createHash('sha256').update(`${designId}\0${relPath}\0${await designContentHash(folder)}\0${info.primary}`).digest('hex');
    const held = this.images.get(key);
    if (held) {
      this.images.delete(key);
      this.images.set(key, held);
      return held;
    }
    const capture = rendered(() => render.capture(designId, relPath, info.primary, null, MAX_RENDER_SCALE, signal)).then((shot): DesignPreviewImage => {
      const { width, height } = pngSize(shot.png);
      return { mimeType: 'image/png', data: Buffer.from(shot.png).toString('base64'), width, height };
    });
    this.images.set(key, capture);
    try {
      const image = await capture;
      this.sizes.set(key, image.data.length);
      this.trim();
      return image;
    } catch (err) {
      if (this.images.get(key) === capture) this.images.delete(key);
      throw err instanceof DesignRenderUnavailableError ? new LocalizedError(l('No Damocles app is attached to render this design.')) : err;
    }
  }

  private trim(): void {
    let total = [...this.sizes.values()].reduce((sum, size) => sum + size, 0);
    for (const key of this.images.keys()) {
      if (this.images.size <= MAX_CACHED_IMAGES && total <= MAX_CACHED_CHARS) return;
      const size = this.sizes.get(key);
      // a capture still running has no size yet and stays
      if (size === undefined) continue;
      this.images.delete(key);
      this.sizes.delete(key);
      total -= size;
    }
  }
}
