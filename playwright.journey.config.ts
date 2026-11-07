import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from '@playwright/test';

// The generated journey spec of the contacts fixture (journeyToPlaywright, PD-45) replayed against its static page, as an
// implementation replays a design's spec against the real app; journey-playwright.test.ts keeps the spec equal to the generator's.
process.env['DAMOCLES_JOURNEY_URL'] = pathToFileURL(path.join(import.meta.dirname, 'e2e', 'fixtures', 'design-app', 'static', 'contacts.html')).href;

export default defineConfig({
  testDir: './e2e/fixtures/design-app/static',
  testMatch: '*.journey.spec.ts',
  outputDir: './dist/e2e-results/journey',
  reporter: [['list']],
  timeout: 30_000,
  // the installed Chrome by default; DAMOCLES_JOURNEY_BROWSER=chromium uses Playwright's own (npx playwright install chromium)
  use: { channel: process.env['DAMOCLES_JOURNEY_BROWSER'] ?? 'chrome' },
});
