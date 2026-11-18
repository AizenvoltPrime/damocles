import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const GUARDED_ROOTS = [path.join(SRC, 'webview'), path.join(SRC, 'desktop')];
// an animation that never ends: on a <Transition>'s own child it replaces the enter or leave animation, and Vue then waits
// out one iteration of it (motion.css `.d-spinning`)
const ENDLESS = /\bd-spinning\b|\banimate-spin\b|\bd-pulsing\b|_infinite\]/;

function vueFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : vueFiles(full);
    return entry.name.endsWith('.vue') ? [full] : [];
  });
}

/** Each opening tag directly inside a <Transition>, with the line it starts on. */
function transitionChildren(source: string): Array<{ line: number; tag: string }> {
  const lines = source.split(/\r?\n/);
  const children: Array<{ line: number; tag: string }> = [];
  lines.forEach((line, start) => {
    if (!/<Transition\b/.test(line)) return;
    const indent = line.search(/\S/);
    let childIndent: number | undefined;
    for (let i = start + 1; i < lines.length; i++) {
      const current = lines[i]!;
      const at = current.search(/\S/);
      if (/^\s*<\/Transition>/.test(current) && at === indent) break;
      if (!/^\s*<[^/!]/.test(current)) continue;
      childIndent ??= at;
      if (at !== childIndent) continue;
      let tag = current;
      for (let j = i; !/>\s*$/.test(lines[j]!) && j + 1 < lines.length; j++) tag += lines[j + 1];
      children.push({ line: i + 1, tag });
    }
  });
  return children;
}

describe('transitions', () => {
  const files = GUARDED_ROOTS.flatMap(vueFiles);

  it('scans the renderer components', () => {
    expect(files.some((file) => file.endsWith('ToolCardFrame.vue'))).toBe(true);
    expect(files.some((file) => file.endsWith('CommitBox.vue'))).toBe(true);
  });

  it('finds an endless animation on a transitioning element', () => {
    const source = ['<Transition name="t-icon">', '  <LoaderCircle', '    v-if="busy"', '    class="d-spinning size-3"', '  />', '</Transition>'].join('\n');
    expect(transitionChildren(source).filter(({ tag }) => ENDLESS.test(tag)).map(({ line }) => line)).toEqual([2]);
  });

  it('never puts an endless animation on an element a <Transition> animates; a wrapper takes the transition', () => {
    const offenders = files.flatMap((file) =>
      transitionChildren(fs.readFileSync(file, 'utf8')).filter(({ tag }) => ENDLESS.test(tag)).map(({ line }) => `${path.relative(SRC, file)}:${line}`));
    expect(offenders).toEqual([]);
  });
});
