// MapReference (PD-13, both rule sets): the elements of a reference image mapped onto what the app has; an element that maps
// onto nothing needs a decision or is left out. It writes references/R<n>.json, so the gate waits for the baseline (PD-42).
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { TOOL_MAP_REFERENCE } from '../../../shared/tool-names';
import type { MapReferenceDetails } from '../../../shared/types/design';
import { readInventory } from '../inventory';
import { mapReference, mapReferenceSchema, ReferenceRefusedError, type MapReferenceInput } from '../references';
import { readTokenNames } from '../tokens';
import { activeRole, type DesignChatToolDeps } from './design-chat-tools';

const DESCRIPTION = [
  'Map a reference image the user attached (saved by Damocles as references/R<n>.png or another image type, named in their message) onto the app: one row per element of the image you take or leave.',
  'mapsTo names what the app has: an inventory component (Button), a tokens.css token (--radius-lg) or a type field (Contact.email). status is mapped (it names one), needsDecision (nothing in the app matches: ask the user, then RecordDecision with source {kind: "reference", ref: "R<n>#<element>"} and mark the new UI data-ds-new citing that decision) or out (not taken). The image guides layout and feel only; it never adds components, tokens or fields by itself. Calling it again replaces the mapping.',
].join('\n\n');

export function createMapReferenceTool(pi: PiCodingAgentModule, deps: DesignChatToolDeps): ToolDefinition {
  return pi.defineTool<typeof mapReferenceSchema, MapReferenceDetails>({
    name: TOOL_MAP_REFERENCE,
    label: 'MapReference',
    // pi then runs the whole batch one call at a time, so two mappings of one reference never interleave their writes.
    executionMode: 'sequential',
    description: DESCRIPTION,
    parameters: mapReferenceSchema,
    execute: async (_toolCallId, params) => {
      const role = activeRole(deps, TOOL_MAP_REFERENCE);
      const input = params as unknown as MapReferenceInput;
      // the image the user attached is written after the same baseline this call waited for, so its files may still be on their way
      await deps.referenceWritten(input.reference);
      let details: MapReferenceDetails;
      try {
        details = await mapReference(role.folder, input, await readInventory(role.folder), await readTokenNames(role.folder));
      } catch (err) {
        if (err instanceof ReferenceRefusedError) throw new Error(`MapReference wrote nothing:\n${err.message}`);
        throw err;
      }
      const open = details.rows.filter((row) => row.status === 'needsDecision').map((row) => row.element);
      const lines = [
        `${details.reference} (${details.image}) maps ${details.rows.filter((row) => row.status === 'mapped').length} of ${details.rows.length} elements.`,
        ...details.rows.map((row) => `- ${row.element}: ${row.status}${row.mapsTo !== null ? ` → ${row.mapsTo}` : ''}`),
        ...(open.length > 0 ? [`Ask the user about ${open.join(', ')}, and record each answer with RecordDecision, source {kind: "reference", ref: "${details.reference}#<element>"}.`] : []),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], details };
    },
  });
}
