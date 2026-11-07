// DesignScreenshot (PD-14, PD-41): each screen at each checked width, rendered in a fresh offscreen page of the attached
// client and returned as image blocks; a model that reads no images gets the probe's outline as text instead.
import * as path from 'node:path';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { MAX_RENDER_SCALE, RENDER_FRAME_HEIGHT } from '../../../shared/design-render';
import { TOOL_DESIGN_SCREENSHOT } from '../../../shared/tool-names';
import type { DesignProbeWidth, DesignScreenshotDetails } from '../../../shared/types/design';
import { designContentHash, listScreenFiles, updateManifest } from '../design-files';
import { checkedWidthsOf, designPreviewInfo, designViewports } from '../design-preview';
import { DesignRenderUnavailableError, rendered } from '../width-checks';
import { activeRole, type DesignChatToolDeps } from './design-chat-tools';

// A text outline costs context too, so one call outlines at most this many screen widths.
export const MAX_OUTLINES = 24;
const MAX_OUTLINE_ELEMENTS = 60;

const screenshotSchema = Type.Object({
  screens: Type.Optional(Type.Array(Type.String({ maxLength: 400 }), { minItems: 1, maxItems: 64, description: 'Screens to capture, relative to the design folder, such as screens/S1-contacts.html; every screen when omitted.' })),
}, { additionalProperties: false });

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

export function createDesignScreenshotTool(pi: PiCodingAgentModule, deps: DesignChatToolDeps): ToolDefinition {
  return pi.defineTool<typeof screenshotSchema, DesignScreenshotDetails>({
    name: TOOL_DESIGN_SCREENSHOT,
    label: 'Screenshot',
    // pi then runs the whole batch one call at a time, so the capture shows the screen a write before it left.
    executionMode: 'sequential',
    description: `Screenshot screens of this design in the Damocles app at each checked width (design.md viewports.checked, by default base and each breakpoint): each image is the top ${RENDER_FRAME_HEIGHT} CSS px of the screen at that width, in a fresh page. Use it to look at your work before DesignCheck and FinishDesign. One call returns at most as many images as your context keeps from one result (12 for most models); name screens to capture fewer.`,
    parameters: screenshotSchema,
    execute: async (_toolCallId, params, signal) => {
      const role = activeRole(deps, TOOL_DESIGN_SCREENSHOT);
      const render = deps.render();
      if (!render) throw new DesignRenderUnavailableError();
      // one failed render ends the others' runs in the app, as the width checks do
      const run = new AbortController();
      const abort = signal ? AbortSignal.any([signal, run.signal]) : run.signal;
      const all = await listScreenFiles(role.folder);
      const files = params.screens ? [...new Set(params.screens)] : all;
      const unknown = files.filter((file) => !all.includes(file));
      if (unknown.length > 0) throw new Error(`Not a screen of this design: ${unknown.join(', ')}. The screens are ${all.join(', ') || 'none yet'}.`);
      if (files.length === 0) throw new Error('This design has no screens yet: write screens/S<n>-<name>.html first.');
      const widths = checkedWidthsOf(await designViewports(role.folder));
      // more images than the model keeps would be pruned from this very result before the model reads it
      const budget = deps.imageBudget();
      const outline = budget === 0;
      const cap = outline ? MAX_OUTLINES : budget;
      if (files.length * widths.length > cap) {
        const fits = Math.floor(cap / widths.length);
        throw new Error(`${files.length} screens at ${widths.length} widths is ${files.length * widths.length} ${outline ? 'outlines' : 'images'}, over the ${cap} one call returns; ${fits > 0 ? `name at most ${fits} screens` : 'design.md checks more widths than that, so check fewer widths'}.`);
      }
      const contentHash = await designContentHash(role.folder);
      const screens = await Promise.all(files.map(async (file) => {
        const info = await designPreviewInfo(role.folder, file);
        if (!info) throw new Error(`${file} cannot be read.`);
        return { file, screenId: info.screenId ?? path.posix.basename(file, '.html') };
      }));
      const details: DesignScreenshotDetails = { screens: [], outline };
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
      if (outline) {
        const probes = await Promise.all(screens.map((screen) => rendered(() => render.probe(role.designId, screen.file, widths.map((checked) => checked.width), null, undefined, abort)))).finally(() => run.abort(new Error('The design screenshot ended')));
        probes.forEach((probe, index) => {
          const screen = screens[index]!;
          details.screens.push({ screen: screen.screenId, file: screen.file, contentHash, widths: probe.widths.map((measured) => ({ breakpoint: widths.find((checked) => checked.width === measured.width)?.breakpoint ?? null, width: measured.width, cssHeight: measured.contentHeight })) });
          content.push({ type: 'text', text: probe.widths.map((measured) => outlineOf(screen.file, measured, widths.find((checked) => checked.width === measured.width)?.breakpoint ?? null)).join('\n\n') });
          if (probe.consoleErrors.length > 0) content.push({ type: 'text', text: `Console errors in ${screen.file}:\n${probe.consoleErrors.map((line) => `- ${line}`).join('\n')}` });
        });
      } else {
        const captures = await Promise.all(screens.map((screen) => Promise.all(widths.map((checked) => rendered(() => render.capture(role.designId, screen.file, checked.width, null, MAX_RENDER_SCALE, abort)))))).finally(() => run.abort(new Error('The design screenshot ended')));
        captures.forEach((shots, index) => {
          const screen = screens[index]!;
          details.screens.push({ screen: screen.screenId, file: screen.file, contentHash, widths: shots.map((shot, at) => ({ breakpoint: widths[at]!.breakpoint, width: shot.cssWidth, cssHeight: shot.cssHeight })) });
          shots.forEach((shot, at) => {
            const checked = widths[at]!;
            content.push({ type: 'text', text: `${screen.file} at ${checked.width} px${checked.breakpoint ? ` (${checked.breakpoint})` : ''}: the top ${shot.cssHeight} of ${shot.contentHeight} CSS px.` });
            content.push({ type: 'image', data: Buffer.from(shot.png).toString('base64'), mimeType: 'image/png' });
          });
        });
      }
      await updateManifest(role.folder, role.designId, (current) => ({
        ...current,
        screens: current.screens.map((screen) => {
          const taken = details.screens.find((candidate) => candidate.file === screen.file);
          return taken ? { ...screen, screenshot: { contentHash, widths: taken.widths.map((width) => width.width) } } : screen;
        }),
      }));
      deps.publish();
      return { content, details };
    },
  });
}
