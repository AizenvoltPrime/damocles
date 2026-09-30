import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../agent-types';
import type { AgentConfig } from '../types';

function cfg(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return { name, description: `${name} desc`, extensions: true, skills: true, systemPrompt: '', promptMode: 'replace', ...over };
}

describe('AgentRegistry', () => {
  it('exposes the three embedded defaults out of the box', () => {
    const r = new AgentRegistry();
    expect(r.getAvailableTypes().sort()).toEqual(['Explore', 'Plan', 'general-purpose']);
    expect(r.getAgentConfig('general-purpose')?.isDefault).toBe(true);
  });

  it('resolves type names case-insensitively', () => {
    const r = new AgentRegistry();
    expect(r.resolveType('explore')).toBe('Explore');
    expect(r.getAgentConfig('EXPLORE')?.name).toBe('Explore');
    expect(r.isValidType('plan')).toBe(true);
  });

  it('user agents overlay defaults by name (latest-name-wins)', () => {
    const r = new AgentRegistry();
    r.register(new Map([['Explore', cfg('Explore', { description: 'custom explore', source: 'project-pi' })]]));
    expect(r.getAgentConfig('Explore')?.description).toBe('custom explore');
    expect(r.getAgentConfig('Explore')?.source).toBe('project-pi');
    // defaults still present
    expect(r.getAgentConfig('Plan')).toBeDefined();
  });

  it('disabled agents are kept but excluded from the available set', () => {
    const r = new AgentRegistry();
    r.register(new Map([['Hidden', cfg('Hidden', { enabled: false })]]));
    expect(r.getAllTypes()).toContain('Hidden');
    expect(r.getAvailableTypes()).not.toContain('Hidden');
    expect(r.isValidType('Hidden')).toBe(false);
  });
});
