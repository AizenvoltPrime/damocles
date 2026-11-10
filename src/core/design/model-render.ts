// A model-facing render through the attached client (D85): `design.render`, or `design.capture` from an app that predates it
// when the call asks for nothing only `design.render` carries.
import type { DesignPreviewHost } from '../../platform/design-preview';
import { DEFAULT_RENDER_MEDIA, DESIGN_RENDER_CLIENT_ABSENT, DESIGN_RENDER_PREDATES, DESIGN_RENDER_UPDATE_NEEDED, MAX_RENDER_SCALE } from '../../shared/design-render';
import type { DesignRender, DesignRenderMedia, DesignRenderRequest } from '../../shared/types/design';
import { DesignRenderUnavailableError, rendered } from './width-checks';

/** A render, and whether an app that predates `design.render` made it (a PNG with the media unpinned). */
export interface ModelRender extends DesignRender {
  readonly legacy: boolean;
}

/** What the model reads beside a legacy render. */
export const LEGACY_RENDER_NOTE = 'rendered by an older Damocles app: PNG, media not pinned';

const sameMedia = (media: DesignRenderMedia): boolean => (Object.keys(DEFAULT_RENDER_MEDIA) as (keyof DesignRenderMedia)[]).every((key) => media[key] === DEFAULT_RENDER_MEDIA[key]);

/** Whether `request` asks for what only `design.render` does: other media, a region or steps. */
export function asksBeyondCapture(request: DesignRenderRequest): boolean {
  return request.steps !== undefined || request.region !== undefined || !sameMedia(request.media);
}

/**
 * `request` of `relPath` rendered by the attached client. Attached apps that all predate `design.render` refuse it with
 * DESIGN_RENDER_PREDATES; then a request that asks nothing beyond the plain capture takes `design.capture`, and one that does
 * fails naming the update. Throws DesignRenderUnavailableError while no client renders designs.
 */
export async function renderForModel(host: DesignPreviewHost, designId: string, relPath: string, request: DesignRenderRequest, signal: AbortSignal): Promise<ModelRender> {
  try {
    return { ...(await host.render(designId, relPath, request, signal)), legacy: false };
  } catch (err) {
    if (err instanceof Error && err.message === DESIGN_RENDER_CLIENT_ABSENT) throw new DesignRenderUnavailableError();
    if (!(err instanceof Error) || err.message !== DESIGN_RENDER_PREDATES) throw err;
  }
  if (asksBeyondCapture(request)) throw new Error(DESIGN_RENDER_UPDATE_NEEDED);
  const shot = await rendered(() => host.capture(designId, relPath, request.width, request.state, MAX_RENDER_SCALE, signal));
  return {
    frames: [{ image: shot.png, mimeType: 'image/png', cssWidth: shot.cssWidth, cssHeight: shot.cssHeight, top: 0 }],
    contentHeight: shot.contentHeight,
    scale: shot.scale,
    moving: false,
    legacy: true,
  };
}
