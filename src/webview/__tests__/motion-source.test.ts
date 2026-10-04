import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const REFERENCE_KEYFRAMES = [
  'd-pop', 'd-up', 'd-fade', 'd-zoom', 'd-spin', 'd-pulse', 'd-blink', 'd-slide', 'nt-in',
  'o-zoom', 'o-fade', 'o-up', 'o-sweep', 'o-grow', 'o-bar', 'd-shimmer', 'd-ring', 'o-glint', 'o-glint-hold',
  'o-zoom-out', 'o-fade-out', 'o-up-out', 'd-pop-out', 'd-pop-top', 'd-pop-top-out',
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|vue|ts)$/.test(name) ? [path] : [];
  });
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/**
 * Plan section 7 Animation: motion.css is the one motion source for the webview, the shell page and the overlay, and
 * the reduced-motion rules zero animation-delay, so a staggered entrance never leaves a row hidden.
 */
describe('motion source', () => {
  it('defines every reference keyframe in motion.css, and no other renderer source defines any keyframe', () => {
    const motion = read('src/webview/styles/motion.css');
    for (const name of REFERENCE_KEYFRAMES) expect(motion).toContain(`@keyframes ${name}{`);

    const elsewhere = [...files(join(ROOT, 'src/webview')), ...files(join(ROOT, 'src/desktop'))]
      .filter((path) => !path.endsWith(join('styles', 'motion.css')))
      .flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/@keyframes\s+([\w-]+)/g)].map(([, name]) => `${relative(ROOT, path)}: ${name}`));
    expect(elsewhere).toEqual([]);
  });

  it('leaves no renderer source on tailwindcss-animate or a Tailwind built-in animation', () => {
    // Only class tokens: motion.css's own `d-fade-in` and Tailwind's `cursor-zoom-in` are preceded by a hyphen.
    const utility = /(?<![\w-])(?:animate-(?:in|out|spin|pulse|ping|bounce)|(?:fade|zoom|spin)-(?:in|out)|slide-(?:in-from|out-to)-[a-z]+)(?!\w)/g;
    const offenders = [...files(join(ROOT, 'src/webview')), ...files(join(ROOT, 'src/desktop'))]
      .flatMap((path) => [...readFileSync(path, 'utf8').matchAll(utility)].map(([name]) => `${relative(ROOT, path)}: ${name}`));
    expect(offenders).toEqual([]);
    expect(read('src/webview/style.css')).not.toContain('tailwindcss-animate');
  });

  it('is imported by the stylesheet the webview, the shell page and the overlay all load', () => {
    expect(read('src/webview/style.css')).toContain('@import "./styles/motion.css";');
    expect(read('src/desktop/shell/style.css')).toContain('@import "../../webview/style.css";');
    expect(read('src/desktop/shell/overlay/overlay.css')).toContain('@import "../style.css";');
  });

  it('zeroes animation durations and delays under both reduced-motion rules', () => {
    const style = read('src/webview/style.css');
    const blocks = [
      style.slice(style.indexOf('@media (prefers-reduced-motion: reduce)'), style.indexOf('[data-reduced-motion] *,')),
      style.slice(style.indexOf('[data-reduced-motion] *,')),
    ];
    for (const block of blocks) {
      expect(block).toMatch(/animation-duration:\s*0\.001ms !important/);
      expect(block).toMatch(/animation-delay:\s*0s !important/);
    }
  });

  it('animates only opacity and transform, except the reference shimmer', () => {
    const motion = read('src/webview/styles/motion.css');
    const offenders = [...motion.matchAll(/@keyframes ([\w-]+)\{(.*)\}\s*$/gm)]
      .filter(([, name]) => name !== 'd-shimmer')
      .flatMap(([, name, body = '']) => [...body.matchAll(/([a-z-]+):/g)].map(([, prop]) => prop).filter((prop) => prop !== 'opacity' && prop !== 'transform').map((prop) => `${name}: ${prop}`));
    expect(offenders).toEqual([]);
  });

  it('keeps the easing curves outside the --d- token family', () => {
    const motion = read('src/webview/styles/motion.css');
    expect(motion).toContain('--ease-out: cubic-bezier(.2,.8,.2,1);');
    expect(motion).toContain('--ease-spring: cubic-bezier(.3,.7,.3,1.3);');
    expect(motion).not.toMatch(/--d-[a-z]/);
  });
});
