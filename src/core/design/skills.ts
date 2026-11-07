// Design skills (PD-13, PD-32): guidance the designer loads on demand, whose validation hints join DesignCheck as
// deterministic rules. The sources are design-skills/*.md, compiled into skills.generated.ts.
import { TOOL_LOAD_DESIGN_SKILL } from '../../shared/tool-names';
import type { LoadDesignSkillDetails } from '../../shared/types/design';
import { DESIGN_SKILLS } from './skills.generated';

/** A rule a skill hint names; design-check.ts implements each, and the generator refuses any not in skill-rules.json. */
export type DesignSkillRule = 'a11y.input-label' | 'a11y.img-alt' | 'states.empty-declared' | 'states.empty-action' | 'states.loading-declared' | 'layout.viewport-font' | 'layout.fixed-width';

export interface DesignSkillHint {
  readonly rule: DesignSkillRule;
  /** The hint's own (PD-52); the model never chooses it. */
  readonly severity: 'error' | 'warning';
  readonly text: string;
}

export interface DesignSkill {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly validationHints: readonly DesignSkillHint[];
  readonly body: string;
}

/** A loaded skill's hint, as DesignCheck applies it. */
export interface LoadedSkillHint extends DesignSkillHint {
  readonly skill: string;
}

export function designSkill(name: string): DesignSkill | undefined {
  return DESIGN_SKILLS.find((skill) => skill.name === name);
}

export function designSkillNames(): string[] {
  return DESIGN_SKILLS.map((skill) => skill.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The skills LoadDesignSkill results on `branch` list, in the order first loaded, so a rewind past a load unloads it. */
export function skillsOnBranch(branch: readonly unknown[]): DesignSkill[] {
  const loaded: DesignSkill[] = [];
  for (const entry of branch) {
    if (!isRecord(entry) || entry['type'] !== 'message') continue;
    const message = entry['message'];
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['toolName'] !== TOOL_LOAD_DESIGN_SKILL || message['isError'] === true) continue;
    const details = message['details'] as Partial<LoadDesignSkillDetails> | undefined;
    if (!isRecord(details) || !Array.isArray(details.skills)) continue;
    for (const item of details.skills) {
      const skill = isRecord(item) && typeof item['name'] === 'string' ? designSkill(item['name']) : undefined;
      if (skill && !loaded.includes(skill)) loaded.push(skill);
    }
  }
  return loaded;
}

/** Every hint of the skills loaded on `branch`. */
export function loadedSkillHints(branch: readonly unknown[]): LoadedSkillHint[] {
  return skillsOnBranch(branch).flatMap((skill) => skill.validationHints.map((hint) => ({ ...hint, skill: skill.name })));
}
