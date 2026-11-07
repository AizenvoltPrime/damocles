// FinishDesign (PD-16, PD-24, PD-52): gates on DesignCheck errors, asks the user to approve a new version, stamps it or reuses
// the latest, writes its outbox record, and hands it to the parent. A turn decider ends the turn after it (PD-28).
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { TOOL_FINISH_DESIGN } from '../../../shared/tool-names';
import { issueCount, type DesignCheckSummary, type DesignJourneyRecord, type FinishDesignDetails, type FinishDesignUnapprovedDetails } from '../../../shared/types/design';
import { l } from '../../l10n';
import { decisionsOnBranch, type DesignRole } from '../design-entries';
import { designContentHash, renderInputHashes, updateManifest } from '../design-files';
import { designStateDirOf } from '../design-paths';
import { changesSince, commitDesignVersion, describeChanges, DESIGN_SUPERSEDED_FINISH, probeDesignVersion, type DesignVersionRecord } from '../design-state';
import { DesignRenderUnavailableError } from '../width-checks';
import { activeRole, checkDesign, checkDesignAtWidths, describeCheck, type DesignChatToolDeps } from './design-chat-tools';

const finishSchema = Type.Object({
  summary: Type.String({ maxLength: 4000, description: 'What this version covers, in two or three sentences, for the user who approves it and the main chat.' }),
}, { additionalProperties: false });

// A remote design chat keeps FULL while no client is attached, so its gate waits for one (PD-11).
export const WIDTH_CHECKS_NEED_APP = 'Open this chat in the Damocles app to run the width checks.';

type FinishResult = { content: { type: 'text'; text: string }[]; details: FinishDesignDetails | FinishDesignUnapprovedDetails | DesignCheckSummary; isError?: true };

function unapproved(details: FinishDesignUnapprovedDetails, text: string): FinishResult {
  return { content: [{ type: 'text', text }], details, isError: true };
}

/** Records the version in the manifest, offers it to the parent and says where it went. */
async function delivered(deps: DesignChatToolDeps, role: DesignRole, record: DesignVersionRecord, reused: boolean): Promise<FinishResult> {
  await updateManifest(role.folder, role.designId, (current) => ({ ...current, status: 'finished', version: record.version }));
  // A version offered before is not news to a user away from the parent.
  const delivery = await deps.offerResult(record, role, !reused);
  deps.publish();
  const details: FinishDesignDetails = { designId: role.designId, version: record.version, reused, delivery, check: { errors: 0, warnings: [...record.check.warnings] }, journeys: [...record.journeys] };
  const where = delivery === 'no-parent'
    ? role.parentSessionId === null
      ? 'No parent chat will receive it: this design was forked from another design chat and has no main chat.'
      : 'No parent chat will receive it: the chat that started this design no longer exists.'
    : delivery === 'notified'
      ? 'The main chat is closed; it receives the version when it is next opened.'
      : 'The main chat receives it now.';
  return {
    content: [{ type: 'text', text: `${reused ? `Nothing changed since v${record.version}, so this is v${record.version} again.` : `The user approved it. Finished v${record.version}.`} ${where} Your turn ends here.` }],
    details,
  };
}

export function createFinishDesignTool(pi: PiCodingAgentModule, deps: DesignChatToolDeps): ToolDefinition {
  return pi.defineTool<typeof finishSchema, unknown>({
    name: TOOL_FINISH_DESIGN,
    label: 'FinishDesign',
    // pi then runs the whole batch one call at a time, so the version holds the bytes the check passed.
    executionMode: 'sequential',
    description: 'Finish this version of the design and hand it to the main chat, which builds from it. DesignCheck runs again first, at the checked widths too where this chat has them, and FinishDesign refuses while it reports any error; warnings travel with the version. Where this chat has PreviewJourney, an interactive design also needs, for every screen with controls, a journey that passed at every journey width against the screen as it is now; a screen with no control needs none. With nothing changed since the last version, it returns that version again. Otherwise it asks the user to approve the version, with your summary, and waits: approved, the version is made and your turn ends; "changes requested" carries the user\'s note, so keep working on it now and call FinishDesign again when it is done; stopped, no version is made and your turn ends.',
    parameters: finishSchema,
    execute: async (toolCallId, params, signal): Promise<FinishResult> => {
      const role = activeRole(deps, TOOL_FINISH_DESIGN);
      const sessionId = deps.sessionId();
      const stateDir = designStateDirOf(role.designId);
      const runSignal = signal ?? new AbortController().signal;
      if ((await deps.readStanding()).kind !== 'current') throw new Error(DESIGN_SUPERSEDED_FINISH);
      const branch = deps.branch();
      let checked: Awaited<ReturnType<typeof checkDesignAtWidths>>;
      try {
        checked = await checkDesignAtWidths(role, deps, true, runSignal);
      } catch (err) {
        if (!(err instanceof DesignRenderUnavailableError)) throw err;
        const { summary } = await checkDesign(role, branch);
        deps.publish();
        const details: DesignCheckSummary = { ...summary, widthChecks: { skipped: l(WIDTH_CHECKS_NEED_APP) } };
        return { content: [{ type: 'text', text: `FinishDesign refused: ${WIDTH_CHECKS_NEED_APP}` }], details, isError: true };
      }
      const { summary, screens } = checked;
      deps.publish();
      if (summary.errors.length > 0) {
        return {
          content: [{ type: 'text', text: `FinishDesign refused: DesignCheck reports ${issueCount(summary.errors)} error(s).\n${describeCheck(summary)}` }],
          details: summary,
          isError: true,
        };
      }
      const decisions = decisionsOnBranch(branch).map(({ id, title, chosen }) => ({ id, title, chosen }));
      const screenHashes = Object.fromEntries(screens.map((screen) => [screen.id, screen.contentHash]));
      const warnings = summary.warnings;
      // each gated screen's journey passed or was waived, or the check above failed (PD-21)
      const journeys = screens.flatMap((screen): DesignJourneyRecord[] => (!screen.journey ? [] : 'waiver' in screen.journey ? [{ screen: screen.id, waiver: true }] : [{ screen: screen.id, ...screen.journey }]));
      const contentHash = await designContentHash(role.folder);
      // A takeover this chat began while the check above, or the approval below, ran must not get a version from the branch it leaves.
      const chat = { sessionId, stillCurrent: () => deps.standing().kind === 'current' };
      const probe = await probeDesignVersion(stateDir, chat, contentHash, decisions);
      if (probe.kind === 'reuse') return delivered(deps, role, probe.record, true);

      const changes = changesSince(probe.previous, screenHashes, decisions);
      const answer = await deps.requestApproval({
        designId: role.designId,
        summary: params.summary,
        previousVersion: probe.previous?.version ?? null,
        changes,
        warnings,
        decisions,
        screens: screens.map(({ id, file }) => ({ id, file })),
        hasParent: await deps.hasParent(role),
      }, runSignal);
      switch (answer?.choice) {
        case undefined:
          return unapproved({ designId: role.designId, approval: 'cancelled' }, 'FinishDesign was cancelled before the user answered, so no version was made. Call FinishDesign again when the user asks for it.');
        case 'changes':
          return unapproved(
            { designId: role.designId, approval: 'changesRequested', feedback: answer.feedback },
            `The user reviewed this version and asked for changes, so no version was made. The user's note:\n\n${answer.feedback}\n\nKeep working on it now, then call FinishDesign again when it is done.`,
          );
        case 'stop':
          return unapproved({ designId: role.designId, approval: 'stopped' }, 'The user stopped this design at its approval, so no version was made. Your turn ends here; wait for the user.');
        case 'approve':
          break;
        default: {
          const unknown: never = answer;
          throw new Error(`FinishDesign got an approval answer it does not know: ${JSON.stringify(unknown)}`);
        }
      }
      const renderHashes = await renderInputHashes(role.folder, screens.map((screen) => screen.file));
      const record = await commitDesignVersion(stateDir, chat, probe, () => designContentHash(role.folder), (version, previous) => ({
        schemaVersion: 1,
        version,
        designId: role.designId,
        title: role.title,
        sessionId,
        toolCallId,
        contentHash,
        decisions,
        screens: screens.map((screen) => screen.id),
        screenHashes,
        renderHashes,
        check: { errors: 0, warnings },
        journeys,
        summary: params.summary,
        changedSinceLast: describeChanges(changesSince(previous, screenHashes, decisions)),
        finishedAt: new Date().toISOString(),
      }));
      return delivered(deps, role, record, false);
    },
  });
}
