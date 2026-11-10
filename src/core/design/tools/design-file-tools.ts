// RemoveDesignFile and OpenPreview (D100): a design chat removes a page or shared file of its design with the records core keeps
// for it, and opens a page's preview tab on the device that shows the chat.
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { TOOL_OPEN_PREVIEW, TOOL_REMOVE_DESIGN_FILE } from '../../../shared/tool-names';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../../shared/relative-path';
import { englishText } from '../../../shared/localized-text';
import type { OpenPreviewDetails, RemoveDesignFileDetails } from '../../../shared/types/design';
import { readDesignFile } from '../design-file-read';
import { dropManifestScreen, listScreenFiles, markDesignEdited, pageAsSpelled } from '../design-files';
import { isDesignerFile, isDesignerRelative, isDesignPreviewPath, MAX_SCREEN_BYTES, SCREENS_DIR } from '../design-paths';
import { withDesignWrite } from '../design-writes';
import { journeyFilesOf } from '../journey';
import { designRuleSetById, type DesignRuleSet } from '../rule-set';
import { removeCheckRecord } from '../width-checks';
import { activeRole, previewFilesChanged, type DesignChatToolDeps } from './design-chat-tools';

const fileSchema = (description: string) => Type.Object({ file: Type.String({ maxLength: 400, description }) }, { additionalProperties: false });

const removeSchema = fileSchema('The file to remove, relative to the design folder: screens/<name>.html, a file below variants/, or shared/<name>.css or .js.');
const previewSchema = fileSchema('The page to show, relative to the design folder: screens/<name>.html or an .html file below variants/, such as variants/accent/b.html.');

function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }];
}

/** Removes `file` and reports whether it was there. */
async function removeIfPresent(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** RemoveDesignFile's result: whether `file` itself was removed, the journey `records` that were, and a screen's other records. */
function removalSummary(file: string, pageRemoved: boolean, records: readonly string[], screen: boolean): string {
  const also = [...(records.length > 0 ? [records.join(' and ')] : []), ...(screen ? ['its manifest entry and its check record'] : [])];
  if (pageRemoved) return `Removed ${file}${records.length > 0 ? ` with ${records.join(' and ')}` : ''}${screen ? ', its manifest entry and its check record' : ''}.`;
  return also.length > 0 ? `${file} was already gone; removed ${also.join(', ')}.` : `${file} was already gone, so nothing was removed.`;
}

/**
 * Why RemoveDesignFile refuses `file` of design folder `folder`, or undefined: it must be a designer file other than design.md,
 * by its path as written and as it resolves, a regular file reached through no link, and a screen as the folder spells it.
 */
async function removalRefusal(folder: string, file: string): Promise<string | undefined> {
  if (!isRelativeFilePath(file) || hasUnsafeWindowsSegment(file) || !isDesignerRelative(file)) {
    return `${file} is not a screen, variant or shared file of this design. Core writes and keeps every other design file.`;
  }
  if (!file.includes('/')) return 'design.md is the design\'s own description and is never removed; edit it instead.';
  const target = path.join(folder, ...file.split('/'));
  if (!isDesignerFile(folder, target)) return `${file} reaches outside this design's files through a link, so it was not removed.`;
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return `${file} does not exist.`;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return `${file} is a link or not a regular file, so it was not removed.`;
  if (file.split('/', 1)[0]!.toLowerCase() === SCREENS_DIR) {
    const screens = await listScreenFiles(folder);
    if (!screens.includes(file)) return `${file} is not a screen as this design spells it. The screens are ${screens.join(', ') || 'none'}.`;
  }
  return undefined;
}

/** The design chat's file removal (both rule sets) and, where the host has the preview, OpenPreview. */
export function createDesignFileTools(pi: PiCodingAgentModule, deps: DesignChatToolDeps, ruleSet: DesignRuleSet): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    pi.defineTool<typeof removeSchema, RemoveDesignFileDetails>({
      name: TOOL_REMOVE_DESIGN_FILE,
      label: 'RemoveDesignFile',
      // pi then runs the whole batch one call at a time, so a write or check beside it sees the folder before or after it.
      executionMode: 'sequential',
      description: 'Remove a screen (screens/<name>.html), a variant file (below variants/) or a shared file (shared/<name>.css or .js) of this design. Removing a screen also removes its journey (screens/<name>.journey.json and .journey.spec.ts), its manifest entry and its check record. design.md, tokens.css and the other files Damocles writes are never removed. A rewind of this chat brings the files back.',
      parameters: removeSchema,
      execute: async (_toolCallId, params) => {
        const role = activeRole(deps, TOOL_REMOVE_DESIGN_FILE);
        const file = params.file;
        const refusal = await removalRefusal(role.folder, file);
        if (refusal) throw new Error(`RemoveDesignFile removed nothing: ${refusal}`);
        const screen = file.startsWith(`${SCREENS_DIR}/`);
        const journey = screen ? journeyFilesOf(file) : undefined;
        const records: string[] = [];
        // The page goes last, so a failure on the way leaves it in place and a second call removes what is left.
        const pageRemoved = await withDesignWrite(role.folder, async () => {
          for (const record of journey ? [journey.journeyFile, journey.specFile] : []) {
            if (await removeIfPresent(path.join(role.folder, ...record.split('/')))) records.push(record);
          }
          if (screen) await dropManifestScreen(role.folder, role.designId, file);
          return removeIfPresent(path.join(role.folder, ...file.split('/')));
        });
        if (screen) await removeCheckRecord(role.designId, file);
        await markDesignEdited(role.folder, role.designId);
        deps.publish();
        const removed = pageRemoved ? [file, ...records] : records;
        previewFilesChanged(deps, role, removed);
        const details: RemoveDesignFileDetails = { file, removed };
        return { content: text(removalSummary(file, pageRemoved, records, screen)), details };
      },
    }),
  ];
  if (!ruleSet.preview) return tools;
  tools.push(pi.defineTool<typeof previewSchema, OpenPreviewDetails>({
    name: TOOL_OPEN_PREVIEW,
    label: 'OpenPreview',
    // pi then runs the whole batch one call at a time, so the tab shows the page a write before it in the batch left.
    executionMode: 'sequential',
    description: 'Open the preview tab of a page of this design beside the chat, or show it when it is open, so the user sees it: a screen (screens/<name>.html) or a variant page (an .html file below variants/). Use it when the user asks to see a page, or to show a page you want them to look at. A screen\'s tab opens by itself at its first write.',
    parameters: previewSchema,
    execute: async (_toolCallId, params) => {
      const role = activeRole(deps, TOOL_OPEN_PREVIEW);
      if (!designRuleSetById(role.ruleSet).preview) throw new Error('OpenPreview runs only in the Damocles app.');
      const file = params.file;
      if (!isDesignPreviewPath(file)) throw new Error(`${file} is not a page of this design: name screens/<name>.html or an .html file below variants/.`);
      // Each spelling would open its own tab with its own state, so only the one the folder holds opens.
      const spelled = await pageAsSpelled(role.folder, file);
      if (spelled !== undefined && spelled !== file) throw new Error(`${file} is not spelled as this design spells it; open ${spelled}.`);
      if (spelled === undefined || (await readDesignFile(role.folder, file, MAX_SCREEN_BYTES)).kind !== 'file') throw new Error(`${file} is not a readable page of this design.`);
      const opening = await deps.openPreview(role.designId, file);
      if ('refused' in opening) throw new Error(`The preview of ${file} did not open: ${englishText(opening.refused)}`);
      return { content: text(`The preview of ${file} is open beside the chat.`), details: { file } };
    },
  }));
  return tools;
}
