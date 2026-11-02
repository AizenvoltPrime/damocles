import { describe, expect, it, vi } from 'vitest';
import { DevcontainerConfigs } from '../devcontainer-configs';

function deferred(): { promise: Promise<string | null>; resolve: (path: string | null) => void; reject: (err: Error) => void } {
  let resolve!: (path: string | null) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string | null>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(): { configs: DevcontainerConfigs; answers: Map<string, ReturnType<typeof deferred>[]>; changed: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  const answers = new Map<string, ReturnType<typeof deferred>[]>();
  const changed = vi.fn();
  const log = vi.fn();
  const configs = new DevcontainerConfigs({
    read: (key) => {
      const answer = deferred();
      answers.set(key, [...(answers.get(key) ?? []), answer]);
      return answer.promise;
    },
    changed,
    log,
  });
  return { configs, answers, changed, log };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the published devcontainer configurations', () => {
  it('reads each listed project once, publishes what it found, and forgets a project no longer listed', async () => {
    const { configs, answers, changed } = setup();
    configs.sync(['web', 'api']);
    configs.sync(['web', 'api']);
    expect([...answers.keys()]).toEqual(['web', 'api']);
    expect(answers.get('web')).toHaveLength(1);
    answers.get('web')![0]!.resolve('C:\\work\\web\\.devcontainer\\devcontainer.json');
    answers.get('api')![0]!.resolve(null);
    await flush();
    expect(configs.get('web')).toBe('C:\\work\\web\\.devcontainer\\devcontainer.json');
    expect(configs.get('api')).toBeUndefined();
    // a project with none changes nothing published
    expect(changed).toHaveBeenCalledTimes(1);

    configs.sync(['api']);
    expect(configs.get('web')).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('reads a tracked project again on refresh and ignores a project it does not track', async () => {
    const { configs, answers, changed } = setup();
    configs.sync(['web']);
    answers.get('web')![0]!.resolve('/srv/web/.devcontainer.json');
    await flush();
    configs.refresh(['web', 'other']);
    expect(answers.has('other')).toBe(false);
    answers.get('web')![1]!.resolve(null);
    await flush();
    expect(configs.get('web')).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps the latest read when an earlier one answers after it', async () => {
    const { configs, answers } = setup();
    configs.sync(['web']);
    configs.refresh(['web']);
    const [first, second] = answers.get('web')!;
    second!.resolve('/srv/web/.devcontainer/devcontainer.json');
    await flush();
    first!.resolve(null);
    await flush();
    expect(configs.get('web')).toBe('/srv/web/.devcontainer/devcontainer.json');
  });

  it('logs a failed read and publishes no configuration for it', async () => {
    const { configs, answers, log } = setup();
    configs.sync(['web']);
    answers.get('web')![0]!.resolve('/srv/web/.devcontainer.json');
    await flush();
    configs.refresh(['web']);
    answers.get('web')![1]!.reject(new Error('the connection ended'));
    await flush();
    expect(configs.get('web')).toBeUndefined();
    expect(log).toHaveBeenCalledWith('[containers] reading the devcontainer configuration of web failed: the connection ended');
  });

  it('drops an answer for a project forgotten while its read ran, even once the project is listed again', async () => {
    const { configs, answers } = setup();
    configs.sync(['web']);
    configs.sync([]);
    answers.get('web')![0]!.resolve('/srv/web/.devcontainer.json');
    await flush();
    expect(configs.get('web')).toBeUndefined();

    configs.sync(['web']);
    configs.sync([]);
    configs.sync(['web']);
    const [, forgotten, current] = answers.get('web')!;
    forgotten!.resolve('/srv/web/.devcontainer.json');
    await flush();
    expect(configs.get('web')).toBeUndefined();
    current!.resolve(null);
    await flush();
    expect(configs.get('web')).toBeUndefined();
  });
});
