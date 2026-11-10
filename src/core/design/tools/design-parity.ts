// DesignParity (PD-13, PD-14, PD-34, PD-42): the parent's real app against its linked design, per width, judged by the
// background model on the 12 fixed checks; the score is computed here from the booleans, never taken from the model.
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { StructuredCompletionRequest, StructuredCompletionResult } from '../../pi-session/structured-completion';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { l, verbatim } from '../../l10n';
import { log } from '../../logger';
import { DEFAULT_RENDER_IMAGE_TARGET, DEFAULT_RENDER_MEDIA, MAX_PROBE_WIDTHS, MAX_RENDER_IMAGE_SIDE, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH } from '../../../shared/design-render';
import { DESIGN_PARITY_CHECK_COUNT, type DesignParityDetails, type DesignParityImage, type DesignParityRefusal, type DesignParityWidth } from '../../../shared/design-parity';
import { englishText, LocalizedError, type LocalizedText } from '../../../shared/localized-text';
import type { BrowserToolAnswer } from '../../../shared/remote-user';
import { TOOL_DESIGN_PARITY } from '../../../shared/tool-names';
import { latestDesignResult, ownDesignLink } from '../design-entries';
import { readManifest } from '../design-files';
import { renderInputsMatch } from '../render-inputs';
import { designStateDirOf } from '../design-paths';
import { readVersionRecord } from '../design-state';
import { checkedWidthsOf, designViewports, type DesignViewports } from '../design-preview';
import { PARITY_CHECKS, PARITY_OUTPUT_TOOL, PARITY_SCHEMA, PARITY_SYSTEM_PROMPT, parityWidth, parseParityVerdicts } from '../parity';
import { isHttpUrl, parseAppFrame, type AppCaptureFailed, type AppFrame } from '../parity-capture';
import { renderForModel, type ModelRender } from '../model-render';
import { DesignRenderUnavailableError } from '../width-checks';

const JUDGE_TIMEOUT_MS = 120_000;
// a page that hangs the browser (a busy loop blocks every CDP call to it) must end the call, as a design render's 60 s does
const APP_CAPTURE_TIMEOUT_MS = 60_000;

/** The app's capture in a browser scope made for one call: on this computer's browser, or for a remote chat the one of the computer showing it. */
export interface ParityAppCapture {
  /** The chat is on a remote host, so its browser runs on the computer that shows it. */
  readonly remote: boolean;
  capture(scope: string, url: string, width: number, signal: AbortSignal): Promise<BrowserToolAnswer>;
  /** Disposes the scope and closes its tabs. */
  release(scope: string): Promise<void>;
}

export interface DesignParityDeps {
  enabled(): boolean;
  designChat(): boolean;
  sessionId(): string;
  branch(): readonly unknown[];
  readonly cwd: string;
  render(): DesignPreviewHost | undefined;
  /** How many images of one result the chat's model keeps; 0 when it reads no images. */
  imageBudget(): number;
  /** `damocles.browser.enabled`, as the browser tools read it. */
  browserEnabled(): boolean;
  /** undefined where this chat has no browser. */
  appCapture(): ParityAppCapture | undefined;
  /** Whether the `design-parity` sub-call's model reads images; null when there is none. */
  judgeReadsImages(): boolean | null;
  judge<T>(req: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>>;
}

const paritySchema = Type.Object({
  screen: Type.String({ minLength: 1, maxLength: 400, description: 'The screen: its id from the design result, such as S1-contacts, or its file, such as screens/S1-contacts.html.' }),
  url: Type.String({ minLength: 1, maxLength: 8192, description: 'The http or https address of the same screen in the running app.' }),
  widths: Type.Optional(Type.Array(Type.Integer({ minimum: MIN_RENDER_WIDTH, maximum: MAX_RENDER_WIDTH }), { minItems: 1, maxItems: MAX_PROBE_WIDTHS, description: "CSS px widths to compare at; by default the design's checked widths." })),
}, { additionalProperties: false });

type ParityContent = ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];

class ParityRefusedError extends LocalizedError {}

const refuse = (text: LocalizedText): never => {
  throw new ParityRefusedError(text);
};

function refusalResult(text: LocalizedText): { content: ParityContent; details: DesignParityRefusal; isError: true } {
  return { content: [{ type: 'text', text: `DesignParity refused: ${englishText(text)}` }], details: { refusal: text }, isError: true };
}

/** The band `width` falls in: the widest breakpoint at or below it, else base. */
function bandOf(width: number, viewports: DesignViewports): string {
  return [...viewports.breakpoints].reverse().find((breakpoint) => breakpoint.width <= width)?.name ?? 'base';
}

function judgeRefusal(result: Exclude<StructuredCompletionResult<unknown>, { kind: 'answered' }>, width: number): LocalizedText {
  if (result.kind === 'rejected') return l('The background model refused the images at {0} px.', width);
  if (result.kind === 'unanswered') return l('The judge did not return the 12 checks at {0} px. Call DesignParity again.', width);
  if (result.cause === 'credential') return l("The Background model's provider refused the sign-in. Sign in again in Settings › Models & accounts.");
  if (result.cause === 'forbidden') return l("The Background model's provider refused access.");
  return l('No model could be reached. Check the Background model in Settings.');
}

function describeWidth(result: DesignParityWidth): string {
  const failed = result.failed.map((check) => `- ${check.id} (${check.label}): ${check.reason || 'no reason given'}`);
  return [`At ${result.width} px (${result.breakpoint}): ${result.passes}/${DESIGN_PARITY_CHECK_COUNT} checks pass, ${result.status}.`, ...failed].join('\n');
}

export function createDesignParityTool(pi: PiCodingAgentModule, deps: DesignParityDeps): ToolDefinition {
  return pi.defineTool<typeof paritySchema, DesignParityDetails | DesignParityRefusal>({
    name: TOOL_DESIGN_PARITY,
    label: 'DesignParity',
    description: `Compare the running app with this chat's linked design while you verify an implementation of it: the screen at each width (by default the design's checked widths) is captured from the design and from the app at the URL you give, and a judge answers ${DESIGN_PARITY_CHECK_COUNT} fixed yes-or-no checks (layout, color, typography, content, components) per width. The score is the checks passed out of ${DESIGN_PARITY_CHECK_COUNT}. It needs the Damocles browser setting on, the app running, this chat open in the Damocles app, and a background model that reads images. Each width returns the design's image and the app's, so one call takes at most half as many widths as your context keeps images from one result (6 for most models).`,
    parameters: paritySchema,
    execute: async (toolCallId, params, signal) => {
      try {
        return await runParity(deps, toolCallId, params, signal ?? new AbortController().signal);
      } catch (err) {
        if (err instanceof ParityRefusedError) return refusalResult(err.text);
        throw err;
      }
    },
  });
}

async function runParity(deps: DesignParityDeps, toolCallId: string, params: { screen: string; url: string; widths?: number[] }, signal: AbortSignal): Promise<{ content: ParityContent; details: DesignParityDetails }> {
  if (!deps.enabled()) refuse(l('Design mode is off. The user turns it on in Settings.'));
  if (deps.designChat()) refuse(l('DesignParity runs in the chat that started the design, not in a design chat.'));
  const branch = deps.branch();
  const link = ownDesignLink(branch, deps.sessionId());
  const delivered = link ? latestDesignResult(branch, link.designId) : undefined;
  if (!link || !delivered) refuse(l('DesignParity runs in a chat that has a finished design. Start one with StartDesign and wait for its result.'));
  const { designId, folder } = link!;
  const screens = (await readManifest(folder, designId)).screens;
  const screen = screens.find((candidate) => candidate.id === params.screen || candidate.file === params.screen);
  if (!screen) refuse(l('Not a screen of this design: {0}. The screens are {1}.', params.screen, screens.map((candidate) => candidate.id).join(', ') || '-'));
  // the render shows the folder as it is now, which must still be the delivered version's
  const version = delivered!.version;
  const record = await readVersionRecord(designStateDirOf(designId), version);
  if (!(await renderInputsMatch(folder, screen!.file, record.renderHashes, record.contentHash))) refuse(l('The design changed since v{0}; compare after its next version.', version));
  if (!isHttpUrl(params.url)) refuse(l('DesignParity opens only http and https addresses.'));
  const viewports = await designViewports(folder);
  const widths = params.widths ? [...new Set(params.widths)].sort((a, b) => a - b) : checkedWidthsOf(viewports).map((checked) => checked.width);
  // more images than the model keeps would be pruned from this very result before it reads them
  const budget = deps.imageBudget();
  if (budget === 1) refuse(l("The chat's model keeps too few images from one result to show the design beside the app."));
  if (budget > 0 && widths.length * 2 > budget) refuse(l('{0} widths need {1} images, over the {2} one result keeps. Name at most {3} widths.', widths.length, widths.length * 2, budget, Math.floor(budget / 2)));
  if (!deps.browserEnabled()) refuse(l('DesignParity captures the app with the Damocles browser, which is off. Turn on the browser in Settings, then call DesignParity again.'));
  const app = deps.appCapture();
  if (!app) refuse(l('DesignParity needs the Damocles browser, which this chat does not have.'));
  const reads = deps.judgeReadsImages();
  if (reads === null) refuse(l('No model could be reached. Check the Background model in Settings.'));
  if (reads === false) refuse(l('The background model cannot read images. Choose one that can in Settings, Background.'));
  const render = deps.render();
  if (!render) refuse(l('No Damocles app is attached to render this design.'));

  const origin = new URL(params.url).origin;
  const scope = `design-parity-${toolCallId}`;
  const results: DesignParityWidth[] = [];
  const frames: { design: string; designHeight: number; app: AppFrame }[] = [];
  try {
    for (const width of widths) {
      // both settle before either failure is reported, so no capture is still running when the scope is released
      const [designed, answered] = await Promise.allSettled([
        // a PNG at the scale the app's capture takes (renderScale within MAX_RENDER_IMAGE_SIDE), so the judge compares like with like
        renderForModel(render!, designId, screen!.file, { width, state: null, media: DEFAULT_RENDER_MEDIA, format: 'png', maxSide: MAX_RENDER_IMAGE_SIDE, quality: DEFAULT_RENDER_IMAGE_TARGET.jpegQuality }, signal),
        withDeadline(app!, scope, params.url, width, signal),
      ]);
      if (designed.status === 'rejected') throw designed.reason;
      if (answered.status === 'rejected') refuse(appErrorRefusal(app!.remote, origin, answered.reason));
      const design = (designed as PromiseFulfilledResult<ModelRender>).value.frames[0]!;
      const frame = parseAppFrame((answered as PromiseFulfilledResult<BrowserToolAnswer>).value, width);
      if ('failure' in frame) refuse(appFailureRefusal(app!.remote, origin, frame));
      const appFrame = frame as AppFrame;
      const designPng = Buffer.from(design.image).toString('base64');
      const judged = await deps.judge<unknown>({
        systemPrompt: PARITY_SYSTEM_PROMPT,
        userMessage: `Screen ${screen!.id} (${screen!.file}) at ${width} CSS px. Image 1: the design. Image 2: the app at ${params.url}.`,
        userImages: [{ data: designPng, mimeType: 'image/png' }, { data: appFrame.png, mimeType: 'image/png' }],
        outputToolName: PARITY_OUTPUT_TOOL,
        outputToolDescription: `Record the ${DESIGN_PARITY_CHECK_COUNT} checks.`,
        schema: PARITY_SCHEMA,
        purpose: 'design-parity',
        attribution: { cwd: deps.cwd, sessionId: deps.sessionId() },
        abortSignal: signal,
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      if (judged.kind !== 'answered') refuse(judgeRefusal(judged as Exclude<typeof judged, { kind: 'answered' }>, width));
      const verdicts = parseParityVerdicts((judged as { value: unknown }).value);
      if (!verdicts) {
        log('[DesignParity] the judge answered at %d px without exactly the %d checks', width, DESIGN_PARITY_CHECK_COUNT);
        refuse(l('The judge did not return the 12 checks at {0} px. Call DesignParity again.', width));
      }
      results.push(parityWidth(width, bandOf(width, viewports), verdicts!));
      frames.push({ design: designPng, designHeight: design.cssHeight, app: appFrame });
    }
  } catch (err) {
    if (err instanceof DesignRenderUnavailableError) refuse(l('No Damocles app is attached to render this design.'));
    throw err;
  } finally {
    await app!.release(scope).catch((err: unknown) => log('[DesignParity] the browser scope could not be released: %s', err instanceof Error ? err.message : String(err)));
  }

  const withImages = budget > 0;
  const images: DesignParityImage[] = [];
  const content: ParityContent = [{
    type: 'text',
    text: `DesignParity of ${screen!.id} against ${params.url}: ${results.map((result) => `${result.passes}/${DESIGN_PARITY_CHECK_COUNT} at ${result.width} px`).join(', ')}. The score counts the ${DESIGN_PARITY_CHECK_COUNT} checks passed (${Object.keys(PARITY_CHECKS).join(', ')}).`,
  }];
  results.forEach((result, index) => {
    content.push({ type: 'text', text: describeWidth(result) });
    if (!withImages) return;
    const frame = frames[index]!;
    content.push({ type: 'text', text: `The design at ${result.width} px:` }, { type: 'image', data: frame.design, mimeType: 'image/png' });
    content.push({ type: 'text', text: `The app at ${result.width} px, the top ${frame.app.cssHeight} of ${frame.app.contentHeight} CSS px:` }, { type: 'image', data: frame.app.png, mimeType: 'image/png' });
    images.push({ width: result.width, kind: 'design', cssHeight: frame.designHeight }, { width: result.width, kind: 'app', cssHeight: frame.app.cssHeight });
  });
  return { content, details: { screen: screen!.id, file: screen!.file, url: params.url, widths: results, images } };
}

class AppCaptureTimeoutError extends Error {}

/** The capture of one width, ended after APP_CAPTURE_TIMEOUT_MS; its work goes on until the scope's release closes its tab. */
function withDeadline(app: ParityAppCapture, scope: string, url: string, width: number, signal: AbortSignal): Promise<BrowserToolAnswer> {
  const deadline = new AbortController();
  const work = app.capture(scope, url, width, AbortSignal.any([signal, deadline.signal]));
  return new Promise<BrowserToolAnswer>((resolve, reject) => {
    const timer = setTimeout(() => {
      deadline.abort();
      reject(new AppCaptureTimeoutError());
    }, APP_CAPTURE_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** R11: what is missing when the app's capture threw: the computer showing a remote chat refuses with its own text (its browser setting). */
function appErrorRefusal(remote: boolean, origin: string, err: unknown): LocalizedText {
  if (err instanceof AppCaptureTimeoutError) return l('The app at {0} did not answer within {1} s. Check that it is running, then call DesignParity again.', origin, APP_CAPTURE_TIMEOUT_MS / 1000);
  if (err instanceof LocalizedError) return err.text;
  return appFailureRefusal(remote, origin, { failure: undefined, detail: err instanceof Error ? err.message : String(err) });
}

/** R11: what is missing when the capture reported a failure: the app, its address, or for a remote chat its forwarded port. */
function appFailureRefusal(remote: boolean, origin: string, { failure, detail }: AppCaptureFailed): LocalizedText {
  switch (failure) {
    case 'scheme':
      return l('DesignParity opens only http and https addresses.');
    case 'load':
      return remote
        ? l('The app at {0} did not load ({1}). Start it on the remote host and check that its port is forwarded in the Ports section, then call DesignParity again.', origin, verbatim(detail))
        : l('The app at {0} did not load ({1}). Start the app or check the address, then call DesignParity again.', origin, verbatim(detail));
    case 'status':
      return l('The app at {0} answered HTTP {1}. Check the address and the app, then call DesignParity again.', origin, detail);
    case 'loadTimeout':
      return l('The app at {0} did not finish loading within {1} s.', origin, detail);
    case 'noPage':
      return l('The browser opened no page to capture the app at {0}.', origin);
    case 'closed':
      return l('The page of the app at {0} closed before it was captured.', origin);
    case 'height':
      return l("The height of the app's page at {0} could not be read.", origin);
    case 'tooLarge':
      return l('The capture of the app at {0} stays too large for one image.', origin);
    case 'error':
    case undefined:
      // an unexpected error's message, or the refusal of the relay or the client-network guard, in English
      return remote
        ? l('The browser on the computer that shows this chat could not capture {0}: {1} For an app on the remote host, check that its port is forwarded in the Ports section.', origin, verbatim(detail))
        : l('The browser could not capture the app at {0}: {1}', origin, verbatim(detail));
  }
}
