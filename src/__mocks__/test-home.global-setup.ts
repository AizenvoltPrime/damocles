import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    testHomeRoot: string;
  }
}

/** One root per run for every test file's home. The teardown runs after the fork workers exit, so
 *  Windows has released their file handles, and it runs even for files whose own hooks were skipped. */
export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "damocles-test-homes-"));
  project.provide("testHomeRoot", root);
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
