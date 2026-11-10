// DesignScreenshot (PD-14, PD-41, D85): screens and variants at the checked widths or the ones asked for, each rendered in a
// fresh offscreen page of the attached client with its media pinned, settled and still, sized and encoded for the chat's
// model, and returned as image blocks; a model that reads no images gets the probe's outline as text instead.
import * as path from 'node:path';
import { Type, type Static } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { journeyProblemSentence, parseJourneySteps } from '../../../shared/design-journey';
import { DEFAULT_RENDER_MEDIA, MAX_FULL_PAGE_FRAMES, MAX_PROBE_WIDTHS, MAX_RENDER_SELECTOR_CHARS, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH, RENDER_FRAME_HEIGHT, renderImageTarget, STABLE_FRAME_TIMEOUT_MS } from '../../../shared/design-render';
import { TOOL_DESIGN_SCREENSHOT } from '../../../shared/tool-names';
import type { DesignProbeWidth, DesignRenderMedia, DesignRenderRequest, DesignScreenshotDetails, JourneyStep } from '../../../shared/types/design';
import { designContentHash, listScreenFiles, updateManifest } from '../design-files';
import { isDesignPreviewPath } from '../design-paths';
import { checkedWidthsOf, designPreviewInfo, designViewports } from '../design-preview';
import { journeyStepsSchema } from '../journey';
import { LEGACY_RENDER_NOTE, renderForModel, type ModelRender } from '../model-render';
import { DesignRenderUnavailableError, inRenderBatches, rendered } from '../width-checks';
import { activeRole, type DesignChatToolDeps } from './design-chat-tools';

// A text outline costs context too, so one call outlines at most this many screen widths.
export const MAX_OUTLINES = 24;
const MAX_OUTLINE_ELEMENTS = 60;
const DEFAULT_STATE = 'default';

const mediaSchema = Type.Object({
  colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')], { description: 'prefers-color-scheme; light by default.' })),
  reducedMotion: Type.Optional(Type.Union([Type.Literal('no-preference'), Type.Literal('reduce')], { description: 'prefers-reduced-motion; no-preference by default.' })),
  forcedColors: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('active')], { description: 'forced-colors, as Windows high contrast sets it; none by default.' })),
  contrast: Type.Optional(Type.Union([Type.Literal('no-preference'), Type.Literal('more'), Type.Literal('less')], { description: 'prefers-contrast; no-preference by default.' })),
  reducedTransparency: Type.Optional(Type.Union([Type.Literal('no-preference'), Type.Literal('reduce')], { description: 'prefers-reduced-transparency; no-preference by default.' })),
}, { additionalProperties: false });

const screenshotSchema = Type.Object({
  screens: Type.Optional(Type.Array(Type.String({ maxLength: 400 }), { minItems: 1, maxItems: 64, description: 'Pages to capture, relative to the design folder: screens such as screens/S1-contacts.html, or variants such as variants/accent/a.html. Every screen when omitted.' })),
  widths: Type.Optional(Type.Array(Type.Integer({ minimum: MIN_RENDER_WIDTH, maximum: MAX_RENDER_WIDTH }), { minItems: 1, maxItems: MAX_PROBE_WIDTHS, description: 'CSS px widths; the checked widths when omitted.' })),
  state: Type.Optional(Type.String({ maxLength: 64, description: 'A state every named page declares in data-ds-states; default when omitted.' })),
  media: Type.Optional(mediaSchema),
  fullPage: Type.Optional(Type.Boolean({ description: `Capture down the whole page in frames of ${RENDER_FRAME_HEIGHT} CSS px, at most ${MAX_FULL_PAGE_FRAMES}.` })),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_RENDER_SELECTOR_CHARS, description: 'A CSS selector: capture the first matching element\'s box. Not with fullPage.' })),
  steps: Type.Optional(journeyStepsSchema(false)),
}, { additionalProperties: false });

type ScreenshotArgs = Static<typeof screenshotSchema>;

/** prepareArguments: the steps through the journey parser, so a malformed step is one sentence naming it, never a validator dump. */
export function prepareScreenshotArguments(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('DesignScreenshot takes an object of options.');
  const record = args as Record<string, unknown>;
  if (record['steps'] === undefined) return record;
  const steps = parseJourneySteps(record['steps'], { asserts: false });
  if ('problems' in steps) throw new Error(`DesignScreenshot captured nothing: ${journeyProblemSentence(steps.problems)}`);
  return { ...record, steps: steps.steps };
}

function outlineOf(file: string, measured: DesignProbeWidth, breakpoint: string | null): string {
  const lines = [`${file} at ${measured.width} px${breakpoint ? ` (${breakpoint})` : ''}: ${measured.contentHeight} px tall${measured.overflow ? `, scrolls sideways to ${measured.scrollWidth} px` : ''}.`];
  for (const element of measured.elements.slice(0, MAX_OUTLINE_ELEMENTS)) {
    const attributes = [element.component && `component ${element.component}`, element.variant && `variant ${element.variant}`, element.bind && `bind ${element.bind}`].filter(Boolean).join(', ');
    lines.push(`- <${element.tag}${element.id ? `#${element.id}` : ''}> ${attributes} at ${element.rect.x},${element.rect.y} ${element.rect.w}×${element.rect.h}${element.visible ? '' : ' (hidden)'}`);
  }
  if (measured.elements.length > MAX_OUTLINE_ELEMENTS) lines.push(`- … ${measured.elements.length - MAX_OUTLINE_ELEMENTS} more`);
  for (const over of measured.overflowing) lines.push(`- overflowing: ${over.element}, ${over.width} px wide`);
  return lines.join('\n');
}

function mediaOf(asked: ScreenshotArgs['media']): DesignRenderMedia {
  return { ...DEFAULT_RENDER_MEDIA, ...Object.fromEntries(Object.entries(asked ?? {}).filter(([, value]) => value !== undefined)) };
}

function mediaText(media: DesignRenderMedia): string {
  const changed = (Object.keys(DEFAULT_RENDER_MEDIA) as (keyof DesignRenderMedia)[]).filter((key) => media[key] !== DEFAULT_RENDER_MEDIA[key]);
  return changed.length === 0 ? '' : ` with ${changed.map((key) => `${key} ${media[key]}`).join(', ')}`;
}

/** What the model reads before a page's images at one width. */
function renderText(file: string, width: number, breakpoint: string | null, shot: ModelRender, media: DesignRenderMedia, region: DesignRenderRequest['region']): string {
  const at = `${file} at ${width} px${breakpoint ? ` (${breakpoint})` : ''}${mediaText(media)}`;
  const last = shot.frames.at(-1)!;
  const bottom = last.top + last.cssHeight;
  const selector = typeof region === 'object' ? region.selector : undefined;
  const shown = selector !== undefined
    ? `the element ${JSON.stringify(selector)} matches, CSS px ${shot.frames[0]!.top} to ${bottom} of the page`
    : shot.frames.length === 1 ? `the top ${last.cssHeight} of ${shot.contentHeight} CSS px` : `${shot.frames.length} frames, CSS px 0 to ${bottom} of ${shot.contentHeight}`;
  const lines = [`${at}: ${shown}.`];
  if (region === 'fullPage' && bottom < shot.contentHeight) lines.push(`CSS px ${bottom} to ${shot.contentHeight} are left out; capture them with a selector for an element there, which is scrolled into view.`);
  if (selector !== undefined && shot.boxBottom !== undefined && bottom < shot.boxBottom) lines.push(`The element is cut at CSS px ${bottom}; its box runs to ${shot.boxBottom}. Capture the rest with a selector for an element further down inside it.`);
  if (shot.moving) lines.push(`${file} at ${width} px never became still within ${STABLE_FRAME_TIMEOUT_MS / 1000} s (an endless animation, a carousel or a timer); the image shows one moment of it.`);
  if (shot.legacy) lines.push(`This image was ${LEGACY_RENDER_NOTE}.`);
  return lines.join('\n');
}

const DESCRIPTION = [
  `Screenshot pages of this design in the Damocles app, each in a fresh page: every screen at each checked width (design.md viewports.checked, by default base and each breakpoint) unless you name screens (variants included, such as variants/accent/a.html) or widths. Each image shows the top ${RENDER_FRAME_HEIGHT} CSS px, after fonts, images and animations finished and the page held still; a page that never holds still (an endless animation, a carousel, a timer) is captured anyway and the result says so.`,
  'Media is pinned to the normal look (light, motion allowed, no forced colors) so the app\'s own theme never leaks in; set media to check a dark theme (colorScheme: "dark", which the screen drives from prefers-color-scheme), reduced motion (reducedMotion: "reduce"), forced colors, contrast or reduced transparency.',
  `fullPage captures down the page in frames of ${RENDER_FRAME_HEIGHT} CSS px (at most ${MAX_FULL_PAGE_FRAMES}); selector captures one element's box. steps (journey steps, no assert needed, exactly one page) run first in the same page, so an open menu or dialog is captured as it stays open: open it with steps instead of editing the screen.`,
  'One call returns at most as many images as your context keeps from one result (12 for most models): pages × widths × frames, with fullPage and selector counted at their most frames.',
].join('\n\n');

export function createDesignScreenshotTool(pi: PiCodingAgentModule, deps: DesignChatToolDeps): ToolDefinition {
  return pi.defineTool<typeof screenshotSchema, DesignScreenshotDetails>({
    name: TOOL_DESIGN_SCREENSHOT,
    label: 'Screenshot',
    // pi then runs the whole batch one call at a time, so the capture shows the screen a write before it left.
    executionMode: 'sequential',
    description: DESCRIPTION,
    parameters: screenshotSchema,
    prepareArguments: (args) => prepareScreenshotArguments(args) as never,
    execute: async (_toolCallId, params, signal) => {
      const role = activeRole(deps, TOOL_DESIGN_SCREENSHOT);
      const render = deps.render();
      if (!render) throw new DesignRenderUnavailableError();
      if (params.fullPage === true && params.selector !== undefined) throw new Error('Use fullPage or selector, not both.');
      // one failed render ends the others' runs in the app, as the width checks do
      const run = new AbortController();
      const abort = signal ? AbortSignal.any([signal, run.signal]) : run.signal;
      const all = await listScreenFiles(role.folder);
      const files = params.screens ? [...new Set(params.screens)] : all;
      // a screen exactly as the screens/ listing spells it (D86); a variant by its own path, read below
      const unknown = files.filter((file) => (file.toLowerCase().startsWith('screens/') ? !all.includes(file) : !isDesignPreviewPath(file)));
      if (unknown.length > 0) throw new Error(`Not a screen or variant of this design: ${unknown.join(', ')}. The screens are ${all.join(', ') || 'none yet'}; a variant is an .html file below variants/.`);
      if (files.length === 0) throw new Error('This design has no screens yet: write screens/S<n>-<name>.html first.');
      const steps = params.steps as JourneyStep[] | undefined;
      if (steps !== undefined && files.length !== 1) throw new Error('steps run in one page: name exactly one screen or variant.');
      const checked = checkedWidthsOf(await designViewports(role.folder));
      const widths = params.widths
        ? [...new Set(params.widths)].sort((a, b) => a - b).map((width) => ({ width, breakpoint: checked.find((entry) => entry.width === width)?.breakpoint ?? null }))
        : checked;
      const state = params.state ?? DEFAULT_STATE;
      const media = mediaOf(params.media);
      const region: DesignRenderRequest['region'] = params.fullPage === true ? 'fullPage' : params.selector !== undefined ? { selector: params.selector } : undefined;
      // more images than the model keeps would be pruned from this very result before the model reads it
      const budget = deps.imageBudget();
      const outline = budget === 0;
      if (outline && (steps !== undefined || region !== undefined || params.media !== undefined)) throw new Error('This model reads no images, so DesignScreenshot gives it a text outline of each page at the normal look; media, fullPage, selector and steps need a model that reads images.');
      const cap = outline ? MAX_OUTLINES : budget;
      const frames = region === undefined ? 1 : MAX_FULL_PAGE_FRAMES;
      const count = files.length * widths.length * frames;
      if (count > cap) {
        const fits = Math.floor(cap / (widths.length * frames));
        throw new Error(`${files.length} pages at ${widths.length} widths${frames > 1 ? ` and up to ${frames} frames each` : ''} is ${count} ${outline ? 'outlines' : 'images'}, over the ${cap} one call returns; ${fits > 0 ? `name at most ${fits} pages` : 'name fewer widths'}.`);
      }
      const contentHash = await designContentHash(role.folder);
      const pages = await Promise.all(files.map(async (file) => {
        const info = await designPreviewInfo(role.folder, file);
        if (!info) throw new Error(`${file} cannot be read.`);
        if (info.states.length > 0 ? !info.states.includes(state) : state !== DEFAULT_STATE) throw new Error(`${file} declares the states ${info.states.join(', ') || 'none'}; ${JSON.stringify(state)} is not one of them.`);
        return { file, screenId: info.screenId ?? path.posix.basename(file, '.html') };
      }));
      const details: DesignScreenshotDetails = { screens: [], outline };
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
      const shownState = state === DEFAULT_STATE ? null : state;
      if (outline) {
        const probes = await inRenderBatches(pages, (page) => rendered(() => render.probe(role.designId, page.file, widths.map((entry) => entry.width), shownState, undefined, abort))).finally(() => run.abort(new Error('The design screenshot ended')));
        probes.forEach((probe, index) => {
          const page = pages[index]!;
          details.screens.push({ screen: page.screenId, file: page.file, contentHash, widths: probe.widths.map((measured) => ({ breakpoint: widths.find((entry) => entry.width === measured.width)?.breakpoint ?? null, width: measured.width, cssHeight: measured.contentHeight })) });
          content.push({ type: 'text', text: probe.widths.map((measured) => outlineOf(page.file, measured, widths.find((entry) => entry.width === measured.width)?.breakpoint ?? null)).join('\n\n') });
          if (probe.consoleErrors.length > 0) content.push({ type: 'text', text: `Console errors in ${page.file}:\n${probe.consoleErrors.map((line) => `- ${line}`).join('\n')}` });
        });
      } else {
        const target = renderImageTarget(deps.model());
        const request = (width: number): DesignRenderRequest => ({
          width,
          state: shownState,
          media,
          ...(steps ? { steps } : {}),
          ...(region ? { region } : {}),
          format: 'jpeg',
          maxSide: target.maxSide,
          quality: target.quality,
          ...(target.maxBytes !== undefined ? { maxBytes: target.maxBytes } : {}),
        });
        const runs = pages.flatMap((page) => widths.map((entry) => ({ page, entry })));
        const all = await inRenderBatches(runs, ({ page, entry }) => renderForModel(render, role.designId, page.file, request(entry.width), abort)).finally(() => run.abort(new Error('The design screenshot ended')));
        pages.forEach((page, index) => {
          const perWidth = all.slice(index * widths.length, (index + 1) * widths.length);
          details.screens.push({ screen: page.screenId, file: page.file, contentHash, widths: perWidth.flatMap((shot, at) => shot.frames.map((frame) => ({ breakpoint: widths[at]!.breakpoint, width: widths[at]!.width, ...(frame.cssWidth !== widths[at]!.width ? { cssWidth: frame.cssWidth } : {}), cssHeight: frame.cssHeight, ...(frame.top > 0 ? { top: frame.top } : {}) }))) });
          perWidth.forEach((shot, at) => {
            const entry = widths[at]!;
            content.push({ type: 'text', text: renderText(page.file, entry.width, entry.breakpoint, shot, media, region) });
            for (const frame of shot.frames) content.push({ type: 'image', data: Buffer.from(frame.image).toString('base64'), mimeType: frame.mimeType });
          });
        });
      }
      await updateManifest(role.folder, role.designId, (current) => ({
        ...current,
        screens: current.screens.map((screen) => {
          const taken = details.screens.find((candidate) => candidate.file === screen.file);
          return taken ? { ...screen, screenshot: { contentHash, widths: [...new Set(taken.widths.map((width) => width.width))] } } : screen;
        }),
      }));
      deps.publish();
      return { content, details };
    },
  });
}
