import { describe, it, expect } from 'vitest';
import { READ_ONLY_SHELL_LIMITS } from '../read-only-shell-rules';
import { classifyReadOnlyShellCommand } from '../readonly-shell';
import { buildPlanModeGuidance } from '../plan-mode-guidance';
import { DEFAULT_AGENTS } from '../subagents/default-agents';
import { buildSpecialistSystemPrompt } from '../../team/prompts';
import { designSection, nestedDesignSection } from '../../design/guidance';
import { designRuleSet } from '../../design/rule-set';

const context = { allowedNetworkHosts: new Set<string>() };

describe('READ_ONLY_SHELL_LIMITS', () => {
  it('names only commands the classifier proves as the ones to use', () => {
    for (const command of ['rg -t md foo', "find src -name '*.ts'", "rg -g '*.md' foo"]) {
      expect(classifyReadOnlyShellCommand('bash', command, context).readOnly, command).toBe(true);
    }
    expect(classifyReadOnlyShellCommand('powershell', 'Get-ChildItem src -Filter *.ts', context).readOnly).toBe(true);
    expect(classifyReadOnlyShellCommand('powershell', 'rg -t md foo', context).readOnly).toBe(true);
  });

  it('describes what the classifier refuses', () => {
    expect(classifyReadOnlyShellCommand('bash', 'grep foo *.md', context).readOnly).toBe(false);
    expect(classifyReadOnlyShellCommand('powershell', "rg -g '*.md' foo", context).readOnly).toBe(false);
    expect(classifyReadOnlyShellCommand('bash', 'cat //host/share/f', context).readOnly).toBe(false);
    expect(classifyReadOnlyShellCommand('powershell', 'Get-Content \\\\host\\share\\f', context).readOnly).toBe(false);
    expect(classifyReadOnlyShellCommand('bash', 'cat /proc/self/environ', context).readOnly).toBe(false);
  });

  it('reaches every prompt that runs under the read-only shell rule', () => {
    const prompts = {
      planMode: buildPlanModeGuidance(),
      explore: DEFAULT_AGENTS.get('Explore')?.systemPrompt,
      plan: DEFAULT_AGENTS.get('Plan')?.systemPrompt,
      reviewer: buildSpecialistSystemPrompt('Reviewer', 'Task', 'review', 'Lead', undefined, undefined, []),
      designChat: designSection('/d', designRuleSet({ designPreview: true })),
      designSubagent: nestedDesignSection('/d', [], [], { writes: false, asks: false }),
    };
    for (const [name, prompt] of Object.entries(prompts)) expect(prompt, name).toContain(READ_ONLY_SHELL_LIMITS);
  });
});
