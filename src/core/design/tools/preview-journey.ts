// PreviewJourney (PD-13, PD-21, PD-45): a short scripted journey through one screen in a fresh page of the attached client at
// each journey width; core writes the journey and its Playwright spec, and records the run for the journey gate.
import * as path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { TOOL_PREVIEW_JOURNEY } from '../../../shared/tool-names';
import { describeJourneyTarget, MAX_JOURNEY_MESSAGE_CHARS, MAX_JOURNEY_OUTLINE_CHARS, MAX_JOURNEY_STEPS, parseJourneySteps, parseJourneyUntested } from '../../../shared/design-journey';
import { visibleLines, visibleText } from '../../../shared/visible-text';
import type { DesignJourneyRun, JourneyFile, JourneyStep, JourneyStepResult, JourneyWidthResult, PreviewJourneyDetails } from '../../../shared/types/design';
import { SCREEN_FILE } from '../../../shared/design-paths';
import { listScreenFiles, updateManifest } from '../design-files';
import { readDesignFile } from '../design-file-read';
import { MAX_SCREEN_BYTES } from '../design-paths';
import { designPreviewInfo, designViewports, journeyViewportsOf } from '../design-preview';
import { journeyFilesOf, prepareJourneyArguments, previewJourneySchema, screenContentHash, writeJourneyFiles } from '../journey';
import { journeyToPlaywright } from '../journey-playwright';
import { renderInputHashes } from '../render-inputs';
import { designRuleSetById } from '../rule-set';
import { DesignRenderUnavailableError, recordJourneyCheck, rendered } from '../width-checks';
import { activeRole, type DesignChatToolDeps } from './design-chat-tools';

const DEFAULT_STATE = 'default';

const DESCRIPTION = [
  `Run a short scripted journey through one screen in the Damocles app, in a fresh page at each journey width (design.md viewports.journey, by default base and the primary width). At most ${MAX_JOURNEY_STEPS} steps, asserts counted; every fill, select, click or press is followed by an assert of its outcome. A call over the limit runs nothing; split a longer flow into journeys that each start from the screen as it loads, and list the rest in untested.`,
  'Steps find elements as people and Playwright do, never by CSS: {role, name} (an ARIA role and the exact accessible name), {label} (the exact text of its <label>, aria-label or aria-labelledby), {placeholder} or {text} (the element\'s whole text). Add exact: false to match a case-insensitive part of the text instead, as Playwright does, for a name that holds a changing count or summary. Exactly one visible element must match. fill types value in place of the field\'s text; select picks the option whose value or label is value; click clicks it as a user would, so a covering element fails it; press focuses it as Playwright does (an element that takes no focus, such as a dialog, leaves the focus where it was) and presses key (Enter, Escape, Tab, Space or an arrow), which goes to the focused element or the page; scroll brings its target into view, and with to: "end" wheels the target, or with no target the page, to its end, which loads what an infinite list loads there. assert waits for expect: {visible: true|false}, {textContains} or {valueEquals}.',
  'Each step has 5 s; the first failure ends that width\'s run. A target hidden at a width fails there and is reported with the width, never skipped: design the screen so each width can do the journey, or give that width its own.',
  'The journey is saved as screens/<screen>.journey.json and a Playwright test, screens/<screen>.journey.spec.ts, which the implementation replays against the real app, so name controls as the real app will. An interactive design finishes only when every screen with controls has a journey that passed at every journey width against the screen as it is now; an edit to the screen makes it run again.',
].join('\n\n');

const cut = (text: string, max: number): string => visibleText(text).slice(0, max);

// What core keeps of the client's answer: exactly one run per requested width, no more results than steps, text bounded.
function checkedRun(run: DesignJourneyRun, widths: readonly number[], steps: number): DesignJourneyRun {
  return {
    consoleErrors: run.consoleErrors.slice(0, 20).map((line) => cut(line, 500)),
    widths: widths.map((width) => {
      const result = run.widths.find((candidate) => candidate.width === width);
      if (!result || result.steps.length > steps) throw new Error('The app answered the journey with a malformed run');
      const stepResults = result.steps.map((step): JourneyStepResult => ({
        ok: step.ok,
        ...(step.hiddenAt !== undefined ? { hiddenAt: step.hiddenAt } : {}),
        ...(step.failure !== undefined ? { failure: step.failure } : {}),
        ...(step.message !== undefined ? { message: cut(step.message, MAX_JOURNEY_MESSAGE_CHARS) } : {}),
      }));
      const passed = stepResults.length === steps && stepResults.every((step) => step.ok);
      return { width, passed, steps: stepResults, ...(result.outline !== undefined ? { outline: visibleLines(result.outline).slice(0, MAX_JOURNEY_OUTLINE_CHARS) } : {}) };
    }),
  };
}

function stepLine(step: JourneyStep): string {
  const what = describeJourneyTarget(step.target);
  switch (step.action) {
    case 'fill': return `fill ${what} with ${JSON.stringify(step.value)}`;
    case 'select': return `select ${JSON.stringify(step.value)} in ${what}`;
    case 'click': return `click ${what}`;
    case 'press': return `press ${step.key} in ${what}`;
    case 'scroll': return step.to === 'end' ? `scroll ${what} to its end` : `scroll ${what} into view`;
    case 'assert': {
      const expected = step.expect!;
      if ('visible' in expected) return `assert ${what} is ${expected.visible ? 'visible' : 'hidden'}`;
      if ('textContains' in expected) return `assert ${what} contains ${JSON.stringify(expected.textContains)}`;
      return `assert ${what} has the value ${JSON.stringify(expected.valueEquals)}`;
    }
  }
}

function report(details: PreviewJourneyDetails, run: DesignJourneyRun): string {
  const lines = [details.passed
    ? `The journey of ${details.screen} passed at ${details.viewports.map((viewport) => `${viewport.width} px`).join(' and ')}: ${details.steps.length}/${details.steps.length} steps.`
    : `The journey of ${details.screen} failed. Fix the screen or the journey and run PreviewJourney again; FinishDesign needs it to pass at every journey width.`];
  details.results.forEach((result: JourneyWidthResult, index) => {
    const viewport = details.viewports[index]!;
    const failed = result.steps.findIndex((step) => !step.ok);
    lines.push(`At ${viewport.width} px${viewport.breakpoint ? ` (${viewport.breakpoint})` : ''}: ${result.steps.filter((step) => step.ok).length}/${details.steps.length} steps passed.`);
    if (failed >= 0) {
      const step = result.steps[failed]!;
      lines.push(`- step ${failed + 1}, ${stepLine(details.steps[failed]!)}: ${step.message ?? 'failed'}${step.hiddenAt !== undefined ? ` (hidden at ${step.hiddenAt} px)` : ''}`);
      if (failed + 1 < details.steps.length) lines.push(`- steps ${failed + 2} to ${details.steps.length} did not run.`);
    }
  });
  lines.push(`Untested: ${details.untested.length > 0 ? details.untested.join('; ') : 'nothing reported'}.`);
  lines.push(`Saved ${details.journeyFile} and the Playwright test ${details.specFile}.`);
  if (run.consoleErrors.length > 0) lines.push(`Console errors:\n${run.consoleErrors.map((line) => `- ${line}`).join('\n')}`);
  for (const [index, result] of run.widths.entries()) {
    if (result.outline !== undefined) lines.push(`The page at ${details.viewports[index]!.width} px where the run ended:\n${result.outline}`);
  }
  return lines.join('\n');
}

export function createPreviewJourneyTool(pi: PiCodingAgentModule, deps: DesignChatToolDeps): ToolDefinition {
  return pi.defineTool<typeof previewJourneySchema, PreviewJourneyDetails>({
    name: TOOL_PREVIEW_JOURNEY,
    label: 'PreviewJourney',
    // pi then runs the whole batch one call at a time, so the journey runs against the screen a write before it left.
    executionMode: 'sequential',
    description: DESCRIPTION,
    parameters: previewJourneySchema,
    prepareArguments: (args) => prepareJourneyArguments(args) as never,
    execute: async (_toolCallId, params, signal) => {
      const role = activeRole(deps, TOOL_PREVIEW_JOURNEY);
      if (!designRuleSetById(role.ruleSet).gate.journeys) throw new Error('PreviewJourney runs only in the Damocles app.');
      const args = params as Record<string, unknown>;
      const parsedSteps = parseJourneySteps(args['steps']);
      const parsedUntested = parseJourneyUntested(args['untested']);
      const problems = [...('problems' in parsedSteps ? parsedSteps.problems : []), ...('problems' in parsedUntested ? parsedUntested.problems : [])];
      if (problems.length > 0 || !('steps' in parsedSteps) || !('untested' in parsedUntested)) throw new Error(`PreviewJourney ran nothing:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
      const { steps } = parsedSteps;
      const { untested } = parsedUntested;
      const relPath = args['screen'];
      if (typeof relPath !== 'string' || !SCREEN_FILE.test(relPath)) throw new Error('screen must be a screen file of this design, such as screens/S1-contacts.html.');
      // exactly as the folder spells it, so the journey's files, the manifest entry and the check record all name one screen
      const screens = await listScreenFiles(role.folder);
      if (!screens.includes(relPath)) throw new Error(`${relPath} is not a screen of this design. The screens are ${screens.join(', ') || 'none yet'}.`);
      const files = journeyFilesOf(relPath);
      if (!files) throw new Error(`${relPath} needs a plain file name (letters, digits, - and _) to have a journey; rename it screens/S<n>-<name>.html.`);
      const info = await designPreviewInfo(role.folder, relPath);
      if (!info) throw new Error(`${relPath} is not a readable screen of this design.`);
      const state = typeof args['state'] === 'string' ? args['state'] : DEFAULT_STATE;
      if (info.states.length > 0 ? !info.states.includes(state) : state !== DEFAULT_STATE) throw new Error(`${relPath} declares the states ${info.states.join(', ') || 'none'}; ${JSON.stringify(state)} is not one of them.`);
      const render = deps.render();
      if (!render) throw new DesignRenderUnavailableError();
      const screenBytes = async (): Promise<Buffer> => {
        const read = await readDesignFile(role.folder, relPath, MAX_SCREEN_BYTES);
        if (read.kind !== 'file') throw new Error(`${relPath} is not a readable screen of this design.`);
        return read.bytes;
      };
      const contentHash = screenContentHash(await screenBytes());
      const renderHash = (await renderInputHashes(role.folder, [relPath]))[relPath]!;
      const viewports = journeyViewportsOf(await designViewports(role.folder));
      const widths = viewports.map((viewport) => viewport.width);
      const outline = deps.imageBudget() === 0;
      const answer = await rendered(() => render.journey(role.designId, relPath, widths, state === DEFAULT_STATE ? null : state, steps, outline, signal ?? new AbortController().signal));
      const run = checkedRun(answer, widths, steps.length);
      // the journey vouches only for the render inputs it ran against (PD-21, D86)
      if ((await renderInputHashes(role.folder, [relPath]))[relPath] !== renderHash) throw new Error(`${relPath} or a file it loads changed while the journey ran; run PreviewJourney again.`);
      const screen = info.screenId ?? path.posix.basename(relPath, '.html');
      const results = run.widths.map(({ width, passed, steps: stepResults }) => ({ width, passed, steps: stepResults }));
      const passed = results.every((result) => result.passed);
      const ranAt = new Date().toISOString();
      const journey: JourneyFile = { schemaVersion: 1, screen, file: relPath, viewports, state, contentHash, renderHash, steps, results, untested, passed, ranAt };
      await writeJourneyFiles(role.folder, files, journey, journeyToPlaywright(journey));
      await recordJourneyCheck(role.designId, { id: screen, file: relPath, contentHash }, {
        screenHash: contentHash,
        state,
        passed,
        results: results.map((result) => ({ width: result.width, passed: result.passed, failedStep: result.passed ? null : result.steps.findIndex((step) => !step.ok) })),
        untested,
        consoleErrors: run.consoleErrors,
        ranAt,
      });
      await updateManifest(role.folder, role.designId, (current) => ({
        ...current,
        screens: current.screens.map((entry) => (entry.file === relPath ? { ...entry, journey: { file: files.journeyFile, spec: files.specFile, widths, passed, untested } } : entry)),
      }));
      deps.publish();
      const details: PreviewJourneyDetails = { screen, relPath, journeyFile: files.journeyFile, specFile: files.specFile, viewports, state, steps, results, untested, passed, contentHash, outline };
      return { content: [{ type: 'text', text: report(details, run) }], details };
    },
  });
}
