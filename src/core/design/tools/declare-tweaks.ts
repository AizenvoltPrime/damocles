// DeclareTweaks (PD-13, FULL): the preview's tweak controls, whose stops are tokens.css tokens only. It writes nothing, so it
// never waits for the checkpoint baseline (PD-42); design.info serves the latest declaration on the branch.
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { TOOL_DECLARE_TWEAKS } from '../../../shared/tool-names';
import type { DeclareTweaksDetails } from '../../../shared/types/design';
import { designRuleSetById } from '../rule-set';
import { readTokenValues } from '../tokens';
import { declareTweaks, declareTweaksSchema, TweaksRefusedError, type DeclareTweaksInput } from '../tweaks';
import { activeRole, type DesignChatToolDeps } from './design-chat-tools';

const DESCRIPTION = [
  'Offer the user 2 to 5 controls in the preview\'s Tweaks column for choices still open, such as corner radius or the accent color. Each control sets one tokens.css token (property) to one of its stops, which are tokens.css tokens too, never a raw value: run ExtractTokens first.',
  'The live preview restyles as the user picks a stop, and no file changes. When the user keeps one, a message "Keep: <label> → <token>" arrives; record it with RecordDecision, source {kind: "tweak", ref: <control id>} and chosen <token>, then use the token in the screens. A control whose property a tweak decision settled comes back locked with that decision.',
].join('\n\n');

export function createDeclareTweaksTool(pi: PiCodingAgentModule, deps: DesignChatToolDeps): ToolDefinition {
  return pi.defineTool<typeof declareTweaksSchema, DeclareTweaksDetails>({
    name: TOOL_DECLARE_TWEAKS,
    label: 'DeclareTweaks',
    description: DESCRIPTION,
    parameters: declareTweaksSchema,
    execute: async (_toolCallId, params) => {
      const role = activeRole(deps, TOOL_DECLARE_TWEAKS);
      if (!designRuleSetById(role.ruleSet).preview) throw new Error('DeclareTweaks runs only in the Damocles app, whose preview shows the controls.');
      let details: DeclareTweaksDetails;
      try {
        details = declareTweaks(params as unknown as DeclareTweaksInput, await readTokenValues(role.folder), deps.branch());
      } catch (err) {
        if (err instanceof TweaksRefusedError) throw new Error(`DeclareTweaks declared nothing:\n${err.message}`);
        throw err;
      }
      const lines = details.controls.map((control) => `- ${control.id} (${control.label}) sets ${control.property}: ${control.stops.map((stop) => stop.token).join(', ')}${control.locked ? `; locked by ${control.locked.decisionId} at ${control.locked.value}` : ''}`);
      return { content: [{ type: 'text', text: [`The preview's Tweaks column shows ${details.controls.length} controls:`, ...lines].join('\n') }], details };
    },
  });
}
