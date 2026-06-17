import { describe, it, expect, vi } from 'vitest';
import { z, type ZodTypeAny, type ZodRawShape } from 'zod';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createBrowserMcpServer } from '../../../browser/mcp-server';
import { buildBrowserPiTools, BROWSER_PI_TOOL_NAMES } from '../browser-tools';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

/**
 * Schema parity (FR-3): the pi-native browser tools must expose the SAME property set, required flags,
 * and enum values as the SDK `damocles-browser` server, under their PascalCase active-set names
 * (`browser_open` → `BrowserOpen`).
 */

/** The PascalCase active-set name for an SDK snake_case tool key. */
const toPascal = (snake: string): string =>
  snake.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

function captureSdkShapes(): Map<string, ZodRawShape> {
  const shapes = new Map<string, ZodRawShape>();
  const stubTool = ((name: string, _desc: string, shape: ZodRawShape) => {
    shapes.set(name, shape);
    return { name };
  }) as unknown as Parameters<typeof createBrowserMcpServer>[2];
  const stubCreate = ((config: { tools: unknown[] }) => config) as unknown as Parameters<typeof createBrowserMcpServer>[1];
  createBrowserMcpServer({} as never, stubCreate, stubTool, z);
  return shapes;
}

function buildPiTools() {
  const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  return buildBrowserPiTools({ pi, browserService: {} as never });
}

function unwrapOptional(schema: ZodTypeAny): ZodTypeAny {
  let s = schema;
  while (s?._def?.innerType) s = s._def.innerType;
  return s;
}

function zodEnumValues(schema: ZodTypeAny): string[] | null {
  const inner = unwrapOptional(schema) as ZodTypeAny & { options?: unknown };
  if (Array.isArray(inner?.options)) return [...inner.options];
  const values = inner?._def?.values;
  return Array.isArray(values) ? [...values] : null;
}

function typeboxEnumValues(prop: { anyOf?: Array<{ const?: string }> } | undefined): string[] | null {
  if (!prop?.anyOf) return null;
  const consts = prop.anyOf.map((s) => s.const).filter((c): c is string => typeof c === 'string');
  return consts.length > 0 ? consts : null;
}

/** Normalized JSON-schema kind for a Zod field (after unwrapping `.optional()`). Integer is bucketed
 * under "number"; enums/unions/unknowns return null (their values are covered by the enum assertion). */
function zodKind(schema: ZodTypeAny): string | null {
  const inner = unwrapOptional(schema);
  if (inner instanceof z.ZodString) return 'string';
  if (inner instanceof z.ZodNumber) return 'number';
  if (inner instanceof z.ZodBoolean) return 'boolean';
  if (inner instanceof z.ZodArray) return 'array';
  if (inner instanceof z.ZodObject) return 'object';
  return null;
}

/** Element kind of a Zod array field, or null if not an array / element is enum-or-unknown. */
function zodArrayItemKind(schema: ZodTypeAny): string | null {
  const arr = unwrapOptional(schema) as ZodTypeAny & { element?: ZodTypeAny; _def?: { type?: ZodTypeAny } };
  const element = (arr.element ?? arr._def?.type) as ZodTypeAny | undefined;
  return element ? zodKind(element) : null;
}

/** Normalized JSON-schema kind for a TypeBox prop, mirroring `zodKind` (integer → "number"); null for
 * unions (`anyOf`) and unknowns. */
function typeboxKind(prop: unknown): string | null {
  const p = prop as { type?: string; anyOf?: unknown } | undefined;
  if (!p || p.anyOf) return null;
  if (p.type === 'integer') return 'number';
  if (p.type === 'string' || p.type === 'number' || p.type === 'boolean' || p.type === 'array' || p.type === 'object') return p.type;
  return null;
}

/** Element kind of a TypeBox array prop (`items`), or null. */
function typeboxArrayItemKind(prop: unknown): string | null {
  return typeboxKind((prop as { items?: unknown } | undefined)?.items);
}

type PiTool = { name: string; parameters: { properties?: Record<string, unknown>; required?: string[] } };

describe('browser tools — schema parity with the SDK server', () => {
  const sdkShapes = captureSdkShapes();
  const piTools = buildPiTools();
  const piByName = new Map(piTools.map((t) => [(t as PiTool).name, t as PiTool]));

  it('exposes exactly the SDK tools under their PascalCase names', () => {
    const expected = [...sdkShapes.keys()].map(toPascal).sort();
    expect([...BROWSER_PI_TOOL_NAMES].sort()).toEqual(expected);
    expect([...piByName.keys()].sort()).toEqual(expected);
  });

  it('every prefixed name fits the provider name regex (<=64 chars, [A-Za-z0-9_-])', () => {
    for (const name of BROWSER_PI_TOOL_NAMES) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  // The two tools with array-of-object params carry NESTED enums the top-level loop can't see; pin
  // them explicitly so a future drift in the nested enum values is caught (FR-3).
  function sdkArrayElementShape(arraySchema: ZodTypeAny): ZodRawShape | null {
    const arr = unwrapOptional(arraySchema) as ZodTypeAny & { element?: ZodTypeAny; _def?: { type?: ZodTypeAny } };
    const element = arr.element ?? arr._def?.type;
    if (!element) return null;
    const el = element as ZodTypeAny & { shape?: ZodRawShape; _def?: { shape?: (() => ZodRawShape) | ZodRawShape } };
    if (el.shape) return el.shape;
    const defShape = el._def?.shape;
    return typeof defShape === 'function' ? defShape() : defShape ?? null;
  }
  function piArrayItemEnum(prop: unknown, field: string): string[] | null {
    const items = (prop as { items?: { properties?: Record<string, unknown> } } | undefined)?.items;
    return typeboxEnumValues(items?.properties?.[field] as { anyOf?: Array<{ const?: string }> });
  }

  it('browser_fill.fields[].type nested enum matches the SDK', () => {
    const expected = ['text', 'select', 'date', 'check', 'uncheck'];
    const sdkShape = sdkArrayElementShape(sdkShapes.get('browser_fill')!.fields as ZodTypeAny);
    const piTool = piByName.get('BrowserFill')!;
    expect(zodEnumValues(sdkShape!.type as ZodTypeAny)).toEqual(expected);
    expect(piArrayItemEnum(piTool.parameters.properties?.fields, 'type')).toEqual(expected);
  });

  it('browser_act.actions[].action nested enum matches the SDK', () => {
    const expected = ['click', 'type', 'select', 'key', 'hover'];
    const sdkShape = sdkArrayElementShape(sdkShapes.get('browser_act')!.actions as ZodTypeAny);
    const piTool = piByName.get('BrowserAct')!;
    expect(zodEnumValues(sdkShape!.action as ZodTypeAny)).toEqual(expected);
    expect(piArrayItemEnum(piTool.parameters.properties?.actions, 'action')).toEqual(expected);
  });

  for (const [sdkName, shape] of captureSdkShapes()) {
    const piName = toPascal(sdkName);

    it(`${sdkName}: property names, required flags, types, and enums match`, () => {
      const tool = piByName.get(piName)!;
      const props = tool.parameters.properties ?? {};
      const required = new Set(tool.parameters.required ?? []);

      const sdkKeys = Object.keys(shape).sort();
      expect(Object.keys(props).sort()).toEqual(sdkKeys);

      for (const key of sdkKeys) {
        const zodRequired = !(shape[key] as ZodTypeAny).isOptional();
        expect(required.has(key), `required mismatch for "${key}"`).toBe(zodRequired);

        const sdkEnum = zodEnumValues(shape[key] as ZodTypeAny);
        const piEnum = typeboxEnumValues(props[key] as { anyOf?: Array<{ const?: string }> });
        expect(piEnum, `enum presence mismatch for "${key}"`).toEqual(sdkEnum);

        const sdkKind = zodKind(shape[key] as ZodTypeAny);
        const piKind = typeboxKind(props[key]);
        if (sdkKind && piKind) {
          expect(piKind, `type mismatch for "${key}"`).toBe(sdkKind);
          if (sdkKind === 'array') {
            const sdkItem = zodArrayItemKind(shape[key] as ZodTypeAny);
            const piItem = typeboxArrayItemKind(props[key]);
            if (sdkItem && piItem) expect(piItem, `array item type mismatch for "${key}"`).toBe(sdkItem);
          }
        }
      }
    });
  }
});
