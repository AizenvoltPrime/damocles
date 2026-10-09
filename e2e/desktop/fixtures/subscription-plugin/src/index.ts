// Stands in for the pinned Claude subscription plugin: like it, it registers the built-in `anthropic` provider again and leaves
// sign-in to pi's own OAuth. support/hermetic.ts seedSubscriptionPlugin installs it where pi keeps the plugin's clone.
interface ExtensionApi {
  registerProvider(name: string, config: { api: string }): void;
}

export default function subscriptionPluginStub(pi: ExtensionApi): void {
  pi.registerProvider('anthropic', { api: 'anthropic-messages' });
}
