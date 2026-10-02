import { describe, it, expect } from 'vitest';
import {
  configMayExposeDirect,
  configToolExposure,
  exposureFromConfigValue,
  layersExposeDirect,
  matchesToolPattern,
  resolveToolExposure,
  toolExposureLayers,
  toolExposureMapForScope,
} from '../exposure';

describe('exposureFromConfigValue — pi values as Damocles exposes them', () => {
  it.each([
    ['hidden', 'off'],
    ['codemode', 'deferred'],
    ['codemode-deferred', 'deferred'],
    ['deferred', 'deferred'],
    ['direct', 'direct'],
    [undefined, 'deferred'],
    ['bogus', 'deferred'],
    ['toString', 'deferred'],
  ])('%s → %s', (value, expected) => {
    expect(exposureFromConfigValue(value)).toBe(expected);
  });
});

describe('matchesToolPattern', () => {
  it('lets `*` match any run, including an empty one, anchored at both ends', () => {
    expect(matchesToolPattern('get_*', 'get_docs')).toBe(true);
    expect(matchesToolPattern('get_*', 'get_')).toBe(true);
    expect(matchesToolPattern('get_*', 'forget_docs')).toBe(false);
    expect(matchesToolPattern('*_docs', 'query_docs')).toBe(true);
    expect(matchesToolPattern('*_docs', 'query_docs_v2')).toBe(false);
    expect(matchesToolPattern('*', 'anything')).toBe(true);
    expect(matchesToolPattern('a*b*c', 'axxbyyc')).toBe(true);
    expect(matchesToolPattern('a*b*c', 'axxcyyb')).toBe(false);
    expect(matchesToolPattern('ab*ba', 'aba')).toBe(false);
    expect(matchesToolPattern('**', '')).toBe(true);
  });

  it('treats every other character literally, regex metacharacters included', () => {
    expect(matchesToolPattern('get.docs*', 'get.docs_v1')).toBe(true);
    expect(matchesToolPattern('get.docs*', 'getXdocs_v1')).toBe(false);
    expect(matchesToolPattern('a+b(c)*', 'a+b(c)d')).toBe(true);
    expect(matchesToolPattern('[x]*', 'x1')).toBe(false);
    expect(matchesToolPattern('$^|?*', '$^|?!')).toBe(true);
    expect(matchesToolPattern('a\\*', 'a\\b')).toBe(true);
  });

  it('a pattern without `*` matches only the identical name', () => {
    expect(matchesToolPattern('get_docs', 'get_docs')).toBe(true);
    expect(matchesToolPattern('get_docs', 'get_docs2')).toBe(false);
  });

  it('stays fast on input that makes a backtracking matcher quadratic or worse', () => {
    const name = 'a'.repeat(200_000);
    const pattern = `${'*a'.repeat(200)}*b*`;
    const started = performance.now();
    expect(matchesToolPattern(pattern, name)).toBe(false);
    expect(matchesToolPattern(`*${'a'.repeat(1_000)}b*`, name)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('configToolExposure — the config side of the precedence', () => {
  it('the exact key wins over a pattern, a pattern over the server exposure, the server exposure over the default', () => {
    const config = {
      exposure: 'hidden' as const,
      toolExposure: { 'get_*': 'direct' as const, get_docs: 'deferred' as const, '*_v2': 'hidden' as const },
    };
    expect(configToolExposure(config, 'get_docs')).toBe('deferred');
    expect(configToolExposure(config, 'get_page')).toBe('direct');
    expect(configToolExposure(config, 'query')).toBe('off');
    expect(configToolExposure({}, 'query')).toBe('deferred');
    expect(configToolExposure({ exposure: 'direct' }, 'query')).toBe('direct');
  });

  it('takes the FIRST matching pattern in the order the file lists them', () => {
    expect(configToolExposure({ toolExposure: { 'get_*': 'direct', '*_docs': 'hidden' } }, 'get_docs')).toBe('direct');
    expect(configToolExposure({ toolExposure: { '*_docs': 'hidden', 'get_*': 'direct' } }, 'get_docs')).toBe('off');
  });

  it('configMayExposeDirect sees a direct server or any direct entry', () => {
    expect(configMayExposeDirect({})).toBe(false);
    expect(configMayExposeDirect({ exposure: 'direct' })).toBe(true);
    expect(configMayExposeDirect({ toolExposure: { 'get_*': 'direct' } })).toBe(true);
    expect(configMayExposeDirect({ exposure: 'codemode', toolExposure: { a: 'hidden' } })).toBe(false);
  });
});

describe('the settings overlay, per tool from inspect()', () => {
  const inspection = {
    userValue: { context7: { 'query-docs': 'off', 'resolve-library-id': 'off', 'get-docs': 'direct' } },
    projectValue: { context7: { 'query-docs': 'deferred' } },
    localValue: { context7: { 'resolve-library-id': 'deferred', 'query-docs': 'off' } },
  };

  it('local beats project beats user beats config, per tool, and names the winning scope', () => {
    const layers = toolExposureLayers(inspection, true);
    expect(resolveToolExposure(layers, 'context7', 'query-docs', 'deferred')).toEqual({ exposure: 'off', source: 'local' });
    expect(resolveToolExposure(layers, 'context7', 'resolve-library-id', 'direct')).toEqual({ exposure: 'deferred', source: 'local' });
    expect(resolveToolExposure(layers, 'context7', 'get-docs', 'off')).toEqual({ exposure: 'direct', source: 'user' });
    expect(resolveToolExposure(layers, 'context7', 'other', 'direct')).toEqual({ exposure: 'direct', source: 'config' });
  });

  it('a project Off overrides a user On for that tool only', () => {
    const layers = toolExposureLayers({ userValue: { ctx: { a: 'deferred', b: 'direct' } }, projectValue: { ctx: { a: 'off' } } }, true);
    expect(resolveToolExposure(layers, 'ctx', 'a', 'deferred')).toEqual({ exposure: 'off', source: 'project' });
    expect(resolveToolExposure(layers, 'ctx', 'b', 'deferred')).toEqual({ exposure: 'direct', source: 'user' });
  });

  it('ignores project and local values in an untrusted folder', () => {
    const layers = toolExposureLayers(inspection, false);
    expect(layers.map((layer) => layer.scope)).toEqual(['user']);
    expect(resolveToolExposure(layers, 'context7', 'resolve-library-id', 'deferred')).toEqual({ exposure: 'off', source: 'user' });
  });

  it('skips malformed layers and values instead of throwing', () => {
    const layers = toolExposureLayers({ userValue: ['off'], projectValue: { context7: 'off' }, localValue: { context7: { a: 'always' } } }, true);
    expect(resolveToolExposure(layers, 'context7', 'a', 'deferred')).toEqual({ exposure: 'deferred', source: 'config' });
  });

  it('never reads an inherited property as an entry', () => {
    const layers = toolExposureLayers({ userValue: { context7: {} } }, true);
    expect(resolveToolExposure(layers, 'context7', 'toString', 'deferred').source).toBe('config');
    expect(resolveToolExposure(layers, 'constructor', 'name', 'deferred').source).toBe('config');
  });

  it('layersExposeDirect finds a direct entry for the server in any layer', () => {
    expect(layersExposeDirect(toolExposureLayers(inspection, true), 'context7')).toBe(true);
    expect(layersExposeDirect(toolExposureLayers(inspection, true), 'other')).toBe(false);
    expect(layersExposeDirect(toolExposureLayers({ projectValue: { s: { a: 'direct' } } }, false), 's')).toBe(false);
  });
});

describe('toolExposureMapForScope — what one scope write leaves behind', () => {
  const below = toolExposureLayers({ userValue: { ctx: { a: 'off' } } }, true).slice(0, 1);

  it('sets the entry and keeps every other server and tool as found', () => {
    const current = { ctx: { b: 'direct' }, other: { x: 'off' } };
    expect(toolExposureMapForScope(current, below, 'ctx', 'a', 'direct', 'deferred')).toEqual({
      ctx: { b: 'direct', a: 'direct' },
      other: { x: 'off' },
    });
    expect(current).toEqual({ ctx: { b: 'direct' }, other: { x: 'off' } });
  });

  it('removes the entry when the scopes below already give the chosen value', () => {
    expect(toolExposureMapForScope({ ctx: { a: 'direct', b: 'off' } }, below, 'ctx', 'a', 'off', 'deferred')).toEqual({ ctx: { b: 'off' } });
  });

  it('removes the entry when the config alone already gives it, and drops a server left empty', () => {
    expect(toolExposureMapForScope({ ctx: { a: 'off' }, k: { z: 'off' } }, [], 'ctx', 'a', 'direct', 'direct')).toEqual({ k: { z: 'off' } });
  });

  it('answers undefined, so the key is removed, when the scope is left with no entry', () => {
    expect(toolExposureMapForScope({ ctx: { a: 'off' } }, [], 'ctx', 'a', 'deferred', 'deferred')).toBeUndefined();
    expect(toolExposureMapForScope(undefined, [], 'ctx', 'a', 'deferred', 'deferred')).toBeUndefined();
  });

  it('starts from an empty map when the scope holds something that is not one', () => {
    expect(toolExposureMapForScope(['junk'], [], 'ctx', 'a', 'off', 'deferred')).toEqual({ ctx: { a: 'off' } });
    expect(toolExposureMapForScope({ ctx: 'junk' }, [], 'ctx', 'a', 'off', 'deferred')).toEqual({ ctx: { a: 'off' } });
  });

  it('saves a server or tool named __proto__ as an own key that survives JSON and reads back', () => {
    const server = toolExposureMapForScope(undefined, [], '__proto__', 'a', 'off', 'deferred')!;
    expect(JSON.parse(JSON.stringify(server))).toEqual(JSON.parse('{"__proto__":{"a":"off"}}'));
    expect(Object.getPrototypeOf(server)).toBe(Object.prototype);

    const tool = toolExposureMapForScope(JSON.parse('{"__proto__":{"b":"direct"}}'), [], 'ctx', '__proto__', 'direct', 'deferred')!;
    expect(JSON.stringify(tool)).toBe('{"__proto__":{"b":"direct"},"ctx":{"__proto__":"direct"}}');
    const layers = toolExposureLayers({ userValue: JSON.parse(JSON.stringify(tool)) }, true);
    expect(resolveToolExposure(layers, 'ctx', '__proto__', 'deferred')).toEqual({ exposure: 'direct', source: 'user' });
    expect(resolveToolExposure(layers, '__proto__', 'b', 'deferred')).toEqual({ exposure: 'direct', source: 'user' });
  });
});
