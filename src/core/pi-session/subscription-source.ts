// A leaf module: the e2e support Playwright loads as ES modules imports it, so it imports nothing that reads a CommonJS global.
import subscriptionPin from './subscription-pin.json' with { type: 'json' };

// `@<sha>`, not `#<sha>`: pi's parseGitUrl keeps a `#` fragment on the clone URL, which breaks `git clone`.
// Before bumping, run the plugin's tests with its @earendil-works/pi-* devDependencies set to Damocles' versions; nothing in this repo's CI clones it.
export const SUBSCRIPTION_SOURCE: string = `${subscriptionPin.repo}@${subscriptionPin.commit}`;
