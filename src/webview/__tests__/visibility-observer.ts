import { vi } from 'vitest';

export interface FakeVisibility {
  /** Reports every observed element as visible or covered, as IntersectionObserver v2 does after its delay; `ratio` is how much of each is in view. */
  report(visible: boolean, ratio?: number): void;
  /** The init of every observer made so far. */
  readonly inits: IntersectionObserverInit[];
  /** The elements observed now. */
  observed(): Element[];
}

/**
 * Replaces IntersectionObserver with one the test drives. Each observe() answers at once with `visible`, as Chromium sends
 * an initial entry; undo with vi.unstubAllGlobals().
 */
export function installVisibilityObserver(visible = true): FakeVisibility {
  const live = new Set<FakeObserver>();
  const inits: IntersectionObserverInit[] = [];
  let current = visible;
  let inView = visible ? 1 : 0;

  class FakeObserver {
    readonly targets = new Set<Element>();
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit = {}) {
      this.callback = callback;
      inits.push(init);
      live.add(this);
    }
    observe(target: Element): void {
      this.targets.add(target);
      this.emit([target]);
    }
    unobserve(target: Element): void {
      this.targets.delete(target);
    }
    disconnect(): void {
      this.targets.clear();
      live.delete(this);
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    emit(targets: Element[]): void {
      const entries = targets.map((target) => ({ target, isIntersecting: current, isVisible: current, intersectionRatio: inView }) as unknown as IntersectionObserverEntry);
      this.callback(entries, this as unknown as IntersectionObserver);
    }
  }

  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return {
    report(next: boolean, ratio = next ? 1 : 0): void {
      current = next;
      inView = ratio;
      for (const observer of [...live]) observer.emit([...observer.targets]);
    },
    inits,
    observed: () => [...live].flatMap((observer) => [...observer.targets]),
  };
}
