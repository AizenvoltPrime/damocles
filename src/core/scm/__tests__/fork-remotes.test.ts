import { describe, expect, it } from 'vitest';
import { GitError, gitFailureCode, pushFailureKind } from '../errors';
import { forkRemotePlan, forkRestorePlan } from '../remotes';

// The push failure classification that alone sends a refused push to the server's access check, and the remote plan of a fork
// (docs/invariants.md "GitHub and GitLab accounts", fork on a denied push).

const failed = (stderr: string): GitError => new GitError('git push failed', 128, '', stderr);

describe('push failure classification', () => {
  it('reads HTTP 403 and the servers\' permission words as authorization', () => {
    for (const stderr of [
      "remote: You are not allowed to push code to this project.\nfatal: unable to access 'https://gitlab.indigital.gr/grp/damocles.git/': The requested URL returned error: 403",
      'remote: Permission to grp/damocles.git denied to astefanopoulos.\nfatal: unable to access \'https://github.com/grp/damocles.git/\': The requested URL returned error: 403',
      'ERROR: Permission to grp/damocles.git denied to astefanopoulos.\nfatal: Could not read from remote repository.',
      'remote: GitLab: You are not allowed to push code to protected branches on this project.',
      'remote: HTTP 403: permission denied',
      // git in German: its own words are translated, curl's and the server's are not
      "remote: Permission to grp/damocles.git denied to astefanopoulos.\nfatal: Zugriff auf 'https://github.com/grp/damocles.git/' nicht möglich: The requested URL returned error: 403",
      'error: RPC-Fehler; HTTP 403 curl 22 The requested URL returned error: 403\nfatal: Die entfernte Seite hat unerwartet abgebrochen',
    ]) expect(pushFailureKind(failed(stderr)), stderr).toBe('authorization');
  });

  it('never reads a non-fast-forward rejection as authorization, even beside a 403 word', () => {
    for (const stderr of [
      " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://gitlab.com/alexios-s/damocles.git'\nhint: Updates were rejected because the remote contains work that you do not have locally.",
      ' ! [rejected]        main -> main (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind',
      ' ! [rejected] main -> main (non-fast-forward)\nremote: Permission to a/b.git denied to x.',
    ]) expect(pushFailureKind(failed(stderr)), stderr).toBe('nonFastForward');
  });

  it('leaves authentication, network and other failures alone', () => {
    for (const stderr of [
      'git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'git@gitlab.com: Permission denied (keyboard-interactive,publickey).\nfatal: Could not read from remote repository.',
      'git@ssh.example.com: Permission denied (gssapi-with-mic,publickey).',
      'Permission denied, please try again.\nPermission denied, please try again.\ngit@ssh.example.com: Permission denied (publickey,password).',
      // a local file git cannot open, and a server's words outside its own lines
      'error: cannot open .git/FETCH_HEAD: Permission denied',
      'fatal: Kann .git/FETCH_HEAD nicht öffnen: Permission denied',
      'hint: You are not allowed to push code to this project.',
      "fatal: Authentication failed for 'https://gitlab.com/a/b.git/'",
      "fatal: unable to access 'https://gitlab.com/a/b.git/': Could not resolve host: gitlab.com",
    ]) expect(pushFailureKind(failed(stderr)), stderr).toBe('other');
    expect(pushFailureKind(new Error('The requested URL returned error: 403'))).toBe('other');
  });
});

describe('ssh\'s publickey refusal', () => {
  it('is read wherever publickey stands in ssh\'s list of methods, and never from the server\'s lines', () => {
    for (const stderr of [
      'git@gitlab.com: Permission denied (publickey).',
      'git@gitlab.com: Permission denied (keyboard-interactive,publickey).',
      'git@ssh.example.com: Permission denied (gssapi-with-mic,publickey,password).',
    ]) expect(gitFailureCode(failed(stderr)), stderr).toBe('publickeyDenied');
    for (const stderr of [
      'remote: Permission denied (publickey).',
      'git@ssh.example.com: Permission denied (password).',
      'Permission denied, please try again.',
    ]) expect(gitFailureCode(failed(stderr)), stderr).toBeUndefined();
  });
});

describe('a ref the server declined', () => {
  // GitHub's protected branch refusal carries none of the authorization words, only git's ref status
  it('reads git\'s [remote rejected] ref status with GitHub\'s protection reasons as rejected, which only the server\'s branch rules then judge', () => {
    for (const stderr of [
      "remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.\nTo https://github.com/grp/damocles.git\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to 'https://github.com/grp/damocles.git'",
      "remote: error: GH013: Repository rule violations found for refs/heads/main.\n ! [remote rejected] main -> main (push declined due to repository rule violations)",
    ]) expect(pushFailureKind(failed(stderr)), stderr).toBe('rejected');
    // a hook's other refusals on a protected branch (a large file, email privacy, secret scanning, a custom hook) are no protection
    for (const stderr of [
      'remote: error: GH001: Large files detected.\n ! [remote rejected] main -> main (pre-receive hook declined)',
      'remote: error: GH007: Your push would publish a private email address.\n ! [remote rejected] main -> main (push declined due to email privacy restrictions)',
      'remote: error: GH009: Secrets detected!\n ! [remote rejected] main -> main (push declined due to secret scanning)',
      ' ! [remote rejected] main -> main (hook declined)',
    ]) expect(pushFailureKind(failed(stderr)), stderr).toBe('other');
    // a non-fast-forward rejection and an authorization failure keep their own kinds
    expect(pushFailureKind(failed(' ! [rejected] main -> main (non-fast-forward)\n ! [remote rejected] x -> x (hook declined)'))).toBe('nonFastForward');
    expect(pushFailureKind(failed('remote: GitLab: You are not allowed to push code to protected branches on this project.\n ! [remote rejected] main -> main (pre-receive hook declined)'))).toBe('authorization');
    expect(pushFailureKind(failed('remote: see "! [remote rejected]" in the docs'))).toBe('other');
  });
});

describe('fork remote plan', () => {
  it('renames origin to upstream and adds the fork as origin', () => {
    expect(forkRemotePlan('origin', ['origin'])).toEqual({ pushed: 'origin', upstreamName: 'upstream', upstreamExists: false });
  });

  it('names the original upstream-2, upstream-3... when upstream is taken, with the note flag', () => {
    expect(forkRemotePlan('origin', ['origin', 'upstream'])).toEqual({ pushed: 'origin', upstreamName: 'upstream-2', upstreamExists: true });
    expect(forkRemotePlan('origin', ['origin', 'upstream', 'upstream-2'])).toEqual({ pushed: 'origin', upstreamName: 'upstream-3', upstreamExists: true });
  });

  it('offers no plan for a push to another remote, an unknown remote, or when every upstream name is taken', () => {
    expect(forkRemotePlan('github', ['github', 'origin'])).toBeUndefined();
    expect(forkRemotePlan('upstream', ['upstream'])).toBeUndefined();
    expect(forkRemotePlan('origin', ['upstream'])).toBeUndefined();
    expect(forkRemotePlan('origin', ['origin', 'upstream', ...Array.from({ length: 99 }, (_, index) => `upstream-${index + 2}`)])).toBeUndefined();
  });

  it('restores in the reverse order: the added origin goes, then the original gets its name back', () => {
    const plan = forkRemotePlan('origin', ['origin', 'upstream'])!;
    expect(forkRestorePlan(plan, { renamed: true, added: true })).toEqual([{ op: 'remove', name: 'origin' }, { op: 'rename', from: 'upstream-2', to: 'origin' }]);
    expect(forkRestorePlan(plan, { renamed: true, added: false })).toEqual([{ op: 'rename', from: 'upstream-2', to: 'origin' }]);
    expect(forkRestorePlan(plan, { renamed: false, added: false })).toEqual([]);
  });
});
