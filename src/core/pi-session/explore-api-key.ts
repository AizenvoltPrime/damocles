import type { Platform } from "../../platform/platform";
import { t } from "../l10n";
import { log } from "../logger";
import { EXPLORE_SECRET_KEYS } from "./explore-providers";

const EXPLORE_PROVIDER_UI = {
  openrouter: { label: "OpenRouter", placeholder: "sk-or-..." },
  gemini: { label: "Gemini", placeholder: "AIza..." },
  stepfun: { label: "StepFun", placeholder: "" },
} as const;
type ExploreProviderId = keyof typeof EXPLORE_PROVIDER_UI;

function keyPrompt(providerId: ExploreProviderId): string {
  switch (providerId) {
    case "openrouter":
      return t("Enter your OpenRouter API key for Explore agents");
    case "gemini":
      return t("Enter your Google Gemini API key");
    case "stepfun":
      return t("Enter your StepFun (Step Plan) API key");
  }
}

/** The `damocles.setExploreApiKey` command: stores, or on an empty answer removes, the configured provider's key. */
export async function setExploreApiKey(platform: Pick<Platform, "settings" | "dialogs" | "secrets" | "notifications">): Promise<void> {
  const raw = platform.settings.get<string>("damocles.explore.provider", "openrouter");
  const providerId: ExploreProviderId = Object.hasOwn(EXPLORE_PROVIDER_UI, raw) ? raw as ExploreProviderId : "openrouter";
  const ui = EXPLORE_PROVIDER_UI[providerId];
  const secretKey = EXPLORE_SECRET_KEYS[providerId];
  const key = await platform.dialogs.inputBox({
    prompt: keyPrompt(providerId),
    password: true,
    placeholder: ui.placeholder,
  });
  if (key === undefined) return;
  let notice: string;
  if (key === "") {
    await platform.secrets.delete(secretKey);
    notice = t("Damocles: {0} API key removed", ui.label);
  } else {
    await platform.secrets.store(secretKey, key);
    notice = t("Damocles: {0} API key saved", ui.label);
  }
  platform.notifications.info(notice).catch((err: unknown) => log("[ExploreApiKey] Could not show the key notice: %O", err));
}
