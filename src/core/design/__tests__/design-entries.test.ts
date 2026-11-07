import { describe, expect, it } from 'vitest';
import { DESIGN_DECISIONS_DETAIL_KEY } from '../../../shared/types/design';
import {
  decisionsOnBranch,
  deliveredBriefs,
  deliveredDesignResults,
  deliveredResultKey,
  designEntryMessage,
  designRoleEntryData,
  designRoleOf,
  finishedDesignVersion,
  inheritedDesignLink,
  ownDesignLink,
  userMessageQuoted,
} from '../design-entries';
import { designFolderOf } from '../design-paths';

let n = 0;
const entry = (fields: Record<string, unknown>): Record<string, unknown> => ({ id: `e${++n}`, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', ...fields });
const custom = (customType: string, data: unknown) => entry({ type: 'custom', customType, data });
const customMessage = (customType: string, details: unknown) => entry({ type: 'custom_message', customType, content: 'x', display: true, details });
const user = (text: string) => entry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = (toolName: string, details: unknown, isError = false) => entry({ type: 'message', message: { role: 'toolResult', toolCallId: `c${n}`, toolName, content: [], details, isError } });
const decision = (id: string, title: string, chosen: string) => ({ v: 1, id, title, chosen, rejected: [], source: { kind: 'question', ref: 'Which?' }, files: [] });

describe('design branch readers', () => {
  it("reads the role from the latest role entry, a design fork's own, with the folder derived from the id, never the file", () => {
    // an earlier build wrote parentTitle, which a session file keeps and the reader ignores
    const original = custom('damocles.design', { v: 1, designId: 'contacts-abcd1234', folder: '/etc', parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts', parentTitle: 'Add contacts' });
    const fork = custom('damocles.design', { v: 1, designId: 'contacts-abcd1234-f0badf00', folder: '/x', parentSessionId: null, ruleSet: 'full', title: 'Contacts' });
    expect(designRoleOf([user('hi'), original])).toEqual({
      designId: 'contacts-abcd1234',
      folder: designFolderOf('contacts-abcd1234'),
      parentSessionId: 'parent-1',
      ruleSet: 'full',
      title: 'Contacts',
    });
    expect(designRoleEntryData(designRoleOf([original])!)).toEqual({ v: 1, designId: 'contacts-abcd1234', folder: designFolderOf('contacts-abcd1234'), parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts' });
    expect(designRoleOf([user('hi'), original, user('more'), fork])).toMatchObject({ designId: 'contacts-abcd1234-f0badf00', folder: designFolderOf('contacts-abcd1234-f0badf00'), parentSessionId: null });
  });

  it('fails closed on a latest role entry that does not parse, never falling back to an earlier design', () => {
    const original = custom('damocles.design', { v: 1, designId: 'contacts-abcd1234', parentSessionId: 'parent-1', ruleSet: 'full' });
    expect(designRoleOf([original, custom('damocles.design', { v: 1, designId: '../x', parentSessionId: null, ruleSet: 'full' })])).toBeUndefined();
  });

  it('ignores a role entry with an unsafe id, a bad rule set or another version', () => {
    for (const data of [
      { v: 1, designId: '../x', parentSessionId: null, ruleSet: 'full' },
      { v: 1, designId: 'ok-12345678', parentSessionId: null, ruleSet: 'wide' },
      { v: 2, designId: 'ok-12345678', parentSessionId: null, ruleSet: 'full' },
      { v: 1, designId: 'ok-12345678', parentSessionId: '../p', ruleSet: 'full' },
    ]) {
      expect(designRoleOf([custom('damocles.design', data)])).toBeUndefined();
    }
  });

  it('takes a parent\'s own link and leaves a fork\'s inherited one inert (PD-37)', () => {
    const branch = [custom('damocles.design-link', { v: 1, designId: 'contacts-abcd1234', folder: '/x', parentSessionId: 'parent-1', title: 'Contacts' })];
    expect(ownDesignLink(branch, 'parent-1')?.designId).toBe('contacts-abcd1234');
    expect(ownDesignLink(branch, 'fork-1')).toBeUndefined();
    expect(inheritedDesignLink(branch, 'fork-1')?.folder).toBe(designFolderOf('contacts-abcd1234'));
    expect(inheritedDesignLink(branch, 'parent-1')).toBeUndefined();
  });

  it('reads decisions from successful AskUserQuestion and RecordDecision results in branch order', () => {
    const branch = [
      toolResult('AskUserQuestion', { [DESIGN_DECISIONS_DETAIL_KEY]: [decision('D1', 'Fidelity', 'Interactive prototype')] }),
      toolResult('RecordDecision', { [DESIGN_DECISIONS_DETAIL_KEY]: [decision('D2', 'Density', 'Compact')] }, true),
      toolResult('Write', { [DESIGN_DECISIONS_DETAIL_KEY]: [decision('D9', 'Forged', 'x')] }),
      toolResult('RecordDecision', { [DESIGN_DECISIONS_DETAIL_KEY]: [decision('D2', 'Density', 'Comfortable'), { v: 1, id: 'bad' }] }),
    ];
    expect(decisionsOnBranch(branch).map((d) => `${d.id} ${d.title} ${d.chosen}`)).toEqual(['D1 Fidelity Interactive prototype', 'D2 Density Comfortable']);
  });

  it('reads the highest version of its own design that a successful FinishDesign handed over', () => {
    const branch = [
      toolResult('FinishDesign', { designId: 'contacts-abcd1234', version: 1 }),
      toolResult('FinishDesign', { designId: 'contacts-abcd1234', version: 3 }, true),
      toolResult('FinishDesign', { designId: 'source-fork1234', version: 5 }),
      toolResult('DesignCheck', { designId: 'contacts-abcd1234', version: 4 }),
      toolResult('FinishDesign', { designId: 'contacts-abcd1234', version: 2 }),
      toolResult('FinishDesign', { designId: 'contacts-abcd1234', version: 0 }),
    ];
    expect(finishedDesignVersion(branch, 'contacts-abcd1234')).toBe(2);
    expect(finishedDesignVersion(branch, 'other-abcd1234')).toBeUndefined();
  });

  it('reads D, the delivered results and briefs, from the branch', () => {
    const branch = [
      customMessage('damocles-design-result', { designId: 'contacts-abcd1234', version: 1 }),
      customMessage('damocles-design-brief', { briefId: 'b1', text: 'x', reopened: false }),
      customMessage('other', { briefId: 'b2' }),
    ];
    expect(deliveredDesignResults(branch)).toEqual(new Set([deliveredResultKey('contacts-abcd1234', 1)]));
    expect(deliveredBriefs(branch)).toEqual(new Set(['b1']));
    expect(designEntryMessage(branch[0], true)).toMatchObject({ type: 'designResult', entryId: branch[0]!['id'], replayed: true });
    expect(designEntryMessage(branch[1], false)).toEqual({ type: 'designBrief', entryId: branch[1]!['id'], brief: { briefId: 'b1', text: 'x', reopened: false } });
    expect(designEntryMessage(branch[2], false)).toBeUndefined();
  });

  it('finds a quote of the user only in user messages, spaces collapsed', () => {
    const branch = [user('Make the table   compact, please'), customMessage('damocles-design-brief', { briefId: 'b1', text: 'use cards' })];
    expect(userMessageQuoted(branch, 'table compact')).toBe(true);
    expect(userMessageQuoted(branch, 'use cards')).toBe(false);
    expect(userMessageQuoted(branch, '   ')).toBe(false);
  });
});
