import { describe, it, expect } from 'vitest';
import { z, type ZodTypeAny, type ZodRawShape } from 'zod';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createMemoryMcpServer } from '../../../memory/mcp-server';
import { buildMemoryPiTools, MEMORY_PI_TOOL_NAMES } from '../memory-tools';

/**
 * Schema parity (FR-3): the pi-native memory tools must expose the SAME property set, required flags,
 * and enum values as the SDK `damocles-memory` server, under their PascalCase active-set names. We
 * capture the SDK Zod shapes via a stub `tool`/`createSdkMcpServer`, build the pi tools, and compare
 * structurally. Each SDK snake_case tool maps to its PascalCase pi name (`save_observation` →
 * `SaveObservation`).
 */

/** The PascalCase active-set name for an SDK snake_case tool key (`save_observation` → `SaveObservation`). */
const toPascal = (snake: string): string =>
  snake.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

function captureSdkShapes(): Map<string, ZodRawShape> {
  const shapes = new Map<string, ZodRawShape>();
  const stubTool = ((name: string, _desc: string, shape: ZodRawShape) => {
    shapes.set(name, shape);
    return { name };
  }) as unknown as Parameters<typeof createMemoryMcpServer>[2];
  const stubCreate = ((config: { tools: unknown[] }) => config) as unknown as Parameters<typeof createMemoryMcpServer>[1];
  createMemoryMcpServer({} as never, stubCreate, stubTool, z, () => 'sid', '/ws');
  return shapes;
}

/** Build the pi tools with a stub service (registration never invokes handlers). */
function buildPiTools() {
  const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  return buildMemoryPiTools({ pi, memoryService: {} as never, getSessionId: () => 'sid', workspace: '/ws' });
}

function unwrapOptional(schema: ZodTypeAny): ZodTypeAny {
  let s = schema;
  while (s?._def?.innerType) s = s._def.innerType;
  return s;
}

/** The enum values of a Zod field (after unwrapping `.optional()`), or null if not an enum. Zod v4
 * stores enum members on `.options` (array); older builds used `_def.values`. */
function zodEnumValues(schema: ZodTypeAny): string[] | null {
  const inner = unwrapOptional(schema) as ZodTypeAny & { options?: unknown };
  if (Array.isArray(inner?.options)) return [...inner.options];
  const values = inner?._def?.values;
  return Array.isArray(values) ? [...values] : null;
}

/** The enum values of a TypeBox prop (a `Type.Union` of literals → `anyOf[].const`), or null. */
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

describe('memory tools — schema parity with the SDK server', () => {
  const sdkShapes = captureSdkShapes();
  const piTools = buildPiTools();
  const piByName = new Map(piTools.map((t) => [(t as PiTool).name, t as PiTool]));

  it('exposes exactly the SDK tools under their PascalCase names', () => {
    const expected = [...sdkShapes.keys()].map(toPascal).sort();
    expect([...MEMORY_PI_TOOL_NAMES].sort()).toEqual(expected);
    expect([...piByName.keys()].sort()).toEqual(expected);
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
