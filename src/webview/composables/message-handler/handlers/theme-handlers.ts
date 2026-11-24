import type { HandlerRegistry } from "../types";
import { useThemePromptStore } from "@/stores/useThemePromptStore";

export function createThemeHandlers(): Partial<HandlerRegistry> {
  return {
    requestThemeChange: (msg) => {
      const { type: _type, ...prompt } = msg;
      useThemePromptStore().setChangePrompt(prompt);
    },

    themeChangeUpdated: (msg) => {
      const { type: _type, promptId, ...update } = msg;
      useThemePromptStore().updateChangePrompt(promptId, update);
    },

    themeChangeClosed: (msg) => {
      useThemePromptStore().removeChangePrompt(msg.promptId);
    },

    requestThemeScreenshot: (msg) => {
      const { type: _type, ...prompt } = msg;
      useThemePromptStore().setScreenshotPrompt(prompt);
    },

    themeScreenshotClosed: (msg) => {
      useThemePromptStore().removeScreenshotPrompt(msg.promptId);
    },

    themeScreenshotGrant: (msg) => {
      useThemePromptStore().setScreenshotGrant(msg.granted);
    },

    requestThemeInstall: (msg) => {
      const { type: _type, ...prompt } = msg;
      useThemePromptStore().setInstallPrompt(prompt);
    },

    themeInstallUpdated: (msg) => {
      useThemePromptStore().updateInstallPrompt(msg.promptId, msg.preview);
    },

    themeInstallProgress: (msg) => {
      useThemePromptStore().updateInstallProgress(msg.promptId, msg.sha256, msg.fraction);
    },

    themeInstallClosed: (msg) => {
      useThemePromptStore().removeInstallPrompt(msg.promptId);
    },
  };
}
