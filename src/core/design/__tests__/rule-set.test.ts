import { describe, expect, it } from 'vitest';
import { designRuleSet, designRuleSetById, DESIGN_PI_TOOL_NAMES, DESIGN_TOOLS_WITHOUT_FOLDER_WRITES } from '../rule-set';
import { VSCODE_HOST_CAPABILITIES } from '../../../shared/types/messages';
import { desktopHostCapabilities } from '../../../desktop/local-services/capabilities';
import { BUILT_DESIGN_TOOL_NAMES } from '../tools/design-tool-specs';

describe('the two design rule sets', () => {
  it('gives the desktop FULL and VS Code REDUCED, from HostCapabilities.designPreview alone', () => {
    expect(designRuleSet(desktopHostCapabilities('win32')).id).toBe('full');
    expect(designRuleSet(VSCODE_HOST_CAPABILITIES).id).toBe('reduced');
    expect(designRuleSetById('full')).toBe(designRuleSet({ designPreview: true }));
    expect(designRuleSetById('reduced')).toBe(designRuleSet({ designPreview: false }));
  });

  it('pins FULL: every design chat tool, StartDesign and DesignParity, the gate on widths and journeys, and Open in browser only from the preview', () => {
    const full = designRuleSet({ designPreview: true });
    expect(full.designTools).toEqual([
      'Inventory', 'ExtractTokens', 'ImportAsset', 'RecordDecision', 'DesignCheck', 'FinishDesign', 'LoadDesignSkill', 'MapReference',
      'DesignScreenshot', 'PreviewJourney', 'DeclareTweaks',
    ]);
    expect(full.parentTools).toEqual(['StartDesign', 'DesignParity']);
    expect(full.gate).toEqual({ staticCheck: true, widthChecks: true, journeys: true });
    expect(full.preview).toBe(true);
    expect(full.openInBrowserFromChat).toBe(false);
  });

  it('pins REDUCED: no preview tools, StartDesign alone, the gate on the static check only, and Open in browser from the chat', () => {
    const reduced = designRuleSet({ designPreview: false });
    expect(reduced.designTools).toEqual(['Inventory', 'ExtractTokens', 'ImportAsset', 'RecordDecision', 'DesignCheck', 'FinishDesign', 'LoadDesignSkill', 'MapReference']);
    expect(reduced.parentTools).toEqual(['StartDesign']);
    expect(reduced.gate).toEqual({ staticCheck: true, widthChecks: false, journeys: false });
    expect(reduced.preview).toBe(false);
    expect(reduced.openInBrowserFromChat).toBe(true);
  });

  it('builds every tool a rule set names, and nothing else', () => {
    expect([...BUILT_DESIGN_TOOL_NAMES].sort()).toEqual(['DeclareTweaks', 'DesignCheck', 'DesignParity', 'DesignScreenshot', 'ExtractTokens', 'FinishDesign', 'ImportAsset', 'Inventory', 'LoadDesignSkill', 'MapReference', 'PreviewJourney', 'RecordDecision', 'StartDesign']);
    for (const name of BUILT_DESIGN_TOOL_NAMES) expect(DESIGN_PI_TOOL_NAMES.has(name)).toBe(true);
    expect([...DESIGN_PI_TOOL_NAMES].sort()).toEqual([...BUILT_DESIGN_TOOL_NAMES].sort());
    // DesignParity captures and judges, and writes nothing into a checkpointed folder
    expect(DESIGN_TOOLS_WITHOUT_FOLDER_WRITES.has('DesignParity')).toBe(true);
  });

  it('keeps DesignScreenshot to FULL, gives both LoadDesignSkill, and lets only the tools that write no folder file skip the checkpoint baseline (PD-42)', () => {
    expect(designRuleSetById('full').designTools).toContain('DesignScreenshot');
    expect(designRuleSetById('reduced').designTools).not.toContain('DesignScreenshot');
    for (const id of ['full', 'reduced'] as const) expect(designRuleSetById(id).designTools).toContain('LoadDesignSkill');
    expect([...DESIGN_TOOLS_WITHOUT_FOLDER_WRITES].sort()).toEqual(['DeclareTweaks', 'DesignParity', 'LoadDesignSkill', 'StartDesign']);
  });

  it('keeps DeclareTweaks to FULL with no baseline wait, and gives both MapReference, which waits (PD-42)', () => {
    expect(designRuleSetById('full').designTools).toContain('DeclareTweaks');
    expect(designRuleSetById('reduced').designTools).not.toContain('DeclareTweaks');
    for (const id of ['full', 'reduced'] as const) expect(designRuleSetById(id).designTools).toContain('MapReference');
    expect(DESIGN_TOOLS_WITHOUT_FOLDER_WRITES.has('DeclareTweaks')).toBe(true);
    expect(DESIGN_TOOLS_WITHOUT_FOLDER_WRITES.has('MapReference')).toBe(false);
  });
});
