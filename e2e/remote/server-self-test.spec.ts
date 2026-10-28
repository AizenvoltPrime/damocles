import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, SSH_TAG, test } from './support/remote';
import { LINUX_TARGET, SERVER_PACKAGES_DIR, serverPackage } from './support/release-mirror';
import { TARGET_HOME, TARGET_USER, type SshdFixture } from './support/sshd';

const PACKAGE = `${TARGET_HOME}/package`;

/** Runs the unpacked package's self-test on the target with `removed` moved out of its node_modules: its exit code and output. */
async function selfTestWithout(fixture: SshdFixture, removed: string | null): Promise<{ code: number; output: string }> {
  const aside = `${TARGET_HOME}/aside`;
  const move = removed === null ? ':' : `mkdir -p ${aside} && mv ${PACKAGE}/node_modules/${removed} ${aside}/moved`;
  const back = removed === null ? ':' : `mv ${aside}/moved ${PACKAGE}/node_modules/${removed}`;
  const printed = await fixture.sh(`${move} && { ${PACKAGE}/bin/damocles-server self-test 2>&1; echo "exit=$?"; } ; ${back}`, TARGET_USER);
  const code = Number(/exit=(\d+)\s*$/.exec(printed)?.[1]);
  return { code, output: printed };
}

test('a package with a module removed from its node_modules fails self-test, naming the module', { tag: SSH_TAG }, async ({ sshd }) => {
  const fixture = await sshd('prod-1');
  const archive = fs.readFileSync(path.join(SERVER_PACKAGES_DIR, serverPackage(LINUX_TARGET)));
  await fixture.sh(`mkdir -p ${PACKAGE} && tar -xzf - -C ${PACKAGE}`, TARGET_USER, archive);
  const packages = (JSON.parse(await fixture.sh(`cat ${PACKAGE}/server-package.json`, TARGET_USER)) as { packages: string[] }).packages;
  // pi-ai loads the Bedrock client only when a Bedrock model runs, so importing the externals never reaches it
  const lazy = '@aws-sdk/client-bedrock-runtime';
  expect(packages).toContain(lazy);

  const intact = await selfTestWithout(fixture, null);
  expect(intact.output).toContain('self-test: modules ok');
  expect(intact.code).toBe(0);

  const external = await selfTestWithout(fixture, 'zod');
  expect(external.output).toMatch(/self-test: modules FAILED: .*\bzod\b/);
  expect(external.code).not.toBe(0);

  const nested = await selfTestWithout(fixture, lazy);
  expect(nested.output).toContain(`self-test: modules FAILED: ${lazy} is missing from node_modules`);
  expect(nested.code).not.toBe(0);
});
