import type { HandlerDependencies, ViewHandlerRegistry } from "../types";
import type { PanelHost } from "../../../../platform/window-service";
import { reportSettingWrite } from "../setting-write";
import type { SettingWrite } from "../../settings-manager/utils";
import { serializeSettingWrite } from "../../../settings-write-chain";
import { REMOTE_CHAT_SETTING_FAILURES, remoteChatSettingKey, type RemoteChatSettingMessage } from "../../../../shared/remote-user";
import { rewriteToolsDisabled, toolGroupSwitchOf, toolSwitchOf } from "../../tool-switches";
import { l } from "../../../l10n";
import { LocalizedError, type LocalizedText } from "../../../../shared/localized-text";

/**
 * A remote chat view's REMOTE_CHAT_USER_SETTING_MESSAGES on this computer's core. Each writes only this computer's user
 * file, never a folder's file or the scope the value is read from, since the chat's project files are on its host.
 */
export function createRemoteChatSettingHandlers(deps: Pick<HandlerDependencies, "postMessage" | "platform">): ViewHandlerRegistry {
  const { postMessage, platform } = deps;

  // under the key main also answers for this write when this core never does
  const keyOf = (type: RemoteChatSettingMessage, group?: string): string => {
    const key = remoteChatSettingKey(type, group);
    if (key === undefined) throw new Error(`${type} names no setting`);
    return key;
  };

  const writeUser = (host: PanelHost, key: string, failure: (detail: LocalizedText) => LocalizedText, value: () => unknown): Promise<boolean> =>
    reportSettingWrite(postMessage, host, key, failure, async (): Promise<SettingWrite> => {
      // a daemon's core holds no user file of this computer; main never routes these to one
      if (platform.remote) throw new LocalizedError(l("User settings change only in the User tab on this computer, so {0} was not changed on this host.", key));
      await platform.settings.update(key, value(), "user");
      return { key, home: "user" };
    }, () => {
      const file = platform.settings.scopeFile("user");
      return { scope: "user", ...(file !== undefined ? { file } : {}) };
    });

  return {
    setPinnedHeaderHidden: async (msg, ctx) => {
      if (msg.type !== "setPinnedHeaderHidden") return;
      const { hidden } = msg;
      if (typeof hidden !== "boolean") throw new Error("Malformed pinned header setting");
      await writeUser(ctx.host, keyOf(msg.type), (detail) => l(REMOTE_CHAT_SETTING_FAILURES.setPinnedHeaderHidden, detail), () => hidden);
    },

    toggleToolGroup: async (msg, ctx) => {
      if (msg.type !== "toggleToolGroup") return;
      const { group, enabled } = toolGroupSwitchOf(msg.group, msg.enabled);
      await writeUser(ctx.host, keyOf(msg.type, group), (detail) => l(REMOTE_CHAT_SETTING_FAILURES.toggleToolGroup, detail), () => enabled);
    },

    // The list comes from the user layer alone: a value the host or a project holds must not be copied into this computer's file.
    toggleTool: async (msg, ctx) => {
      if (msg.type !== "toggleTool") return;
      const { toolName, enabled } = toolSwitchOf(msg.toolName, msg.enabled);
      const key = keyOf(msg.type);
      await serializeSettingWrite(() => writeUser(ctx.host, key, (detail) => l(REMOTE_CHAT_SETTING_FAILURES.toggleTool, detail), () =>
        rewriteToolsDisabled(platform.settings.inspect<unknown>(key).userValue, toolName, enabled)));
    },
  };
}
