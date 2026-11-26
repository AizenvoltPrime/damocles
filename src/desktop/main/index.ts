import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { connect as netConnect } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, clipboard, crashReporter, dialog, Menu, nativeTheme, net, powerMonitor, screen, session, shell as electronShell, systemPreferences, webContents, WebContentsView, type WebContents } from 'electron';
import { installLogSink, log, showLog } from '../../core/logger';
import { processProfiler, StallMonitor } from '../local-services/stall-monitor';
import type { WalkHost } from '../../core/search-walk/walk-host';
import { locateSettingsFile, saveSettingsFileText } from '../../core/chat-panel/settings-file-editor';
import { installPlatform } from '../../core/platform-host';
import { l, verbatim } from '../../core/l10n';
import type { ChatActivity } from '../../core/pi-session/session-state';
import { clockFormatter } from '../../shared/clock';
import { LANGUAGE_PREFERENCE_KEY } from '../../shared/language-preference';
import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import { movePreferApiKeyFlagsToSettings, runLegacySettingsMigrations } from '../../core/config/legacy-settings-migrations';
import { migrateRenamedSearchSettings } from './search-settings-migration';
import { deleteRetiredSecrets } from '../../core/config/retired-secrets';
import { providerKeyStored } from '../../core/pi-session/custom-providers';
import { PROVIDER_SECRET_KEYS } from '../../core/pi-session/explore-providers';
import { DAMOCLES_DESIGNS_DIR, DAMOCLES_HOME_DIR, FOLDER_IDENTITIES_PATH, THEMES_DIR, WORKTREES_ROOT_DIR } from '../../core/paths';
import { resolveSshExecutable, resolveSshKeygenExecutable, type SshClientChoice } from '../../core/system-tools';
import { folderKey, folderKeyOn } from '../../core/workspace-folders/folder-key';
import { chatRecordHolding, folderContains, liveWorkingFolders } from '../../core/worktrees/records';
import { homeDirectory } from '../../core/workspace-folders/folder-registry';
import { checkWhenAdmitted, createFolderPresenceProbe, folderPresenceOf, type FolderPresence } from '../../core/workspace-folders/folder-presence-probe';
import { FolderIdentityStore } from '../../core/project-relocation/identity-store';
import type { Disposable } from '../../platform/disposable';
import type { InputBoxOptions } from '../../platform/dialog-service';
import type { PanelOptions } from '../../platform/window-service';
import type { ChatPermissions, CoreRequests, PanelCreate } from '../core-protocol';
import type { RelayView } from './core-services/host-services';
import type { StoredSession } from '../../shared/types/session';
import type { ChatAttachmentInput } from '../../shared/types/chat-attachment';
import { MAX_OVERLAY_TAGS, OVERLAY_CHANNELS, type HostNotice, type HostUpdateAction, type OverlayAnswer, type OverlayRect, type OverlayRequest, type OverlaySettingsAwayState, type OverlayState, type OverlayThemesResult, type ThemeEditorResult } from '../preload/overlay-channels';
import { characterAssets, characterState, parseProjectsFile, PROJECTS_FILE, type PinEdit } from '../../shared/themes/characters';
import type { NotificationHost, NotificationProject } from '../preload/notifications';
import { canCheck, type UpdateSnapshot, type VersionInfo } from '../preload/updates';
import {
  MAX_TAG_LENGTH,
  moveGridPane,
  NEW_CHAT_ID_PREFIX,
  toggleGridMaximize,
  toggleGridPane,
  type GridPane,
  type GridSlot,
  type ShellGridLayout,
  hostAttention,
  type HostAttention,
  type ChatMutationResult,
  type ChatStatus,
  type FileRef,
  type FilesDeleteResult,
  type FilesListResult,
  type FilesMutationResult,
  type RemoveProjectResult,
  type SelectChatResult,
  type ShellChat,
  type ShellChatList,
  type ShellFocusPart,
  type ShellBrowserPage,
  type ShellProject,
  type ShellRelocation,
  type ShellRelocationReason,
  type ShellState,
  type ShellWindowState,
} from '../preload/shell-channels';
import type { QuickOpenMode, QuickOpenScope } from '../preload/overlay-channels';
import type { ChatCommand, ChatReviewScope, ExtensionToWebviewMessage, SettingsFileScope } from '../../shared/types/messages';
import { ChatReviewHost } from './chat-review-host';
import { handleAboutChannels, runUpdateAction, type AboutDeps } from './about-channels';
import { ActivationFocus, onWindowActivated, onWindowDeactivated } from './activation-focus';
import { trayIcon, windowIcon } from './app-icon';
import { startDesktopCore, type CoreConnectionDeps, type DesktopCore } from './bootstrap';
import { CORE_READY_TIMEOUT_MS } from './core-process';
import { restartDecision, RESTART_LIMIT } from '../local-services/restart-policy';
import type { CoreClient } from './core-client';
import { BrowserTabs } from './browser-tabs';
import { createDesignSession, serveDesignRequest, type DesignViewTarget } from './design/design-session';
import { DesignPreviews, markupPngForModel, type DesignSupport } from './design/design-previews';
import { HtmlPreviews } from './html-preview/html-previews';
import { servedPathRefusal } from '../../core/served-pages/root-files';
import { ServedRoots } from './html-preview/served-roots';
import { createPreviewSession } from './html-preview/preview-session';
import { DesignRunner } from './design/design-runner';
import { DesignRendererHost } from './design/design-renderer-host';
import { startDesignRenderer } from './design/design-renderer-start';
import { isDesignRendererLaunch, runDesignRenderer } from './design/design-renderer';
import { DesignServer } from './design/design-server';
import { authorityOfLocation, designScreenAuthority } from './design/design-screen-path';
import type { BrowserTabSource } from './editor-pane';
import { isDesignId, isDesignScreenFile } from '../../shared/design-paths';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import type { DesignPreviewFile, JourneyStep } from '../../shared/types/design';
import { parseJourneySteps } from '../../shared/design-journey';
import { ChatUnloads, chatsToUnload, ChatWorkQueue } from './chat-pool';
import { chatProjectKey, keptRemoteChatProjectKey, projectStays, savedChatProjectKey } from './chat-project';
import { showHeldChat } from './held-chat';
import { isActiveActivity } from '../../shared/chat-retention';
import { chatTitle, panelTitle, storedTitle } from './chat-title';
import { chatActions, refusesMirrored } from './chat-actions';
import { END_OF_OPTIONS, isSafeThemeLaunch, optionArgs, parseCliPathAction, parseCrashReporterDirectory, parseUserDataDir, registersLinkScheme, relaunchArgs } from './cli';
import { CoreHost } from './core-host';
import { bounded, createQuitJoins, detachRemotes, QuitLifecycle, shutDown } from './shutdown';
import {
  DEFAULT_FILES_EXCLUDE,
  DEFAULT_SEARCH_EXCLUDE,
  DESKTOP_CONFIGURATION,
  FILES_EXCLUDE_SETTING,
  FORGE_AGENT_TOOLS_SETTING,
  THEMES_AGENT_TOOLS_SETTING,
  GIT_BLAME_EDITOR_DECORATION_SETTING,
  SEARCH_EXCLUDE_SETTING,
  isDesktopSettingValue,
  NOTIFICATION_SOUND_SETTING,
  NOTIFICATIONS_SETTING,
  REMOTE_CLOSE_WITH_RUNNING_AGENTS_SETTING,
  REMOTE_TERMINAL_IDLE_DAYS_SETTING,
  REMOTE_AUTO_FORWARD_PORTS_SETTING,
  REMOTE_AUTO_FORWARD_PORTS_FALLBACK_SETTING,
  UPDATE_CHECK_AUTOMATICALLY_SETTING,
  RESTORE_LAYOUT_SETTING,
  PROJECTS_VIEW_SETTING,
  SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING,
  TERMINAL_DEFAULT_PROFILE_SETTING,
  TERMINAL_PROFILES_SETTING,
  THEME_SETTING,
  THEMES_DARK_SETTING,
  THEMES_LIGHT_SETTING,
  SHOW_WALLPAPERS_SETTING,
  WALLPAPER_CONTRAST_SETTING,
  type DesktopLanguageSetting,
} from '../local-services/desktop-configuration';
import { BackupStore } from './documents/backups';
import { followsLocalLinksOnly, type Project } from '../local-services/confine';
import type { OpenFolder } from '../../platform/workspace-folders';
import { DocumentService, RefusedPathError, type Location, type TextDocument } from './documents/document-service';
import { sessionFileEngines } from './documents/session-files';
import { EditorPane, editorSettings, withoutHosts, type RemoteDiffTarget, type RootCloseAnswers } from './editor-pane';
import { FormatService } from './formatting/format-service';
import { FileTree, type FilesTarget } from './files/file-tree';
import { FileTransferService } from './files/file-transfer';
import { FilesClipboard } from './files/files-clipboard';
import { LinkRefusedError, OpenUrl } from './remote/open-url';
import { CliRefusal, CliRequests, claimWaitMarker, deleteWaitMarker, resolveRemoteSpec } from './cli-requests';
import { createCliPath, withInstallerLog, type CliPath } from './cli-path';
import { cliPathActions } from './cli-path-actions';
import { broadcastEnvironmentChange, USER_ENVIRONMENT_KEY, windowsRegistry } from './cli-path-win32';
import { waitMarkerFolder } from '../cli/cli-protocol';
import { EDITOR_CONFIRM_DOCUMENT_BYTES } from '../../shared/types/messages';
import { LAST_DOWNLOAD_FOLDER_KEY, TransferGestures } from './files/transfer-gestures';
import { filesFailureMessage, settleFilesAction, type FilesAction, type FilesFailed } from './files/files-failure';
import { QuickOpenIndex, QuickOpenPicker } from './quick-open';
import { acceleratorLabel, CommandPalette, desktopCommands, NEXT_WALLPAPER_ACCELERATOR } from './commands';
import {
  buildNewTerminalMenu,
  joinTerminalItems,
  openNewTerminalMenu,
  pickDefaultProfile,
  pickNewTerminal,
  pickTerminalColor,
  pickTerminalIcon,
  serveTerminalPick,
  startPickedTerminal,
  TerminalPickSession,
  type DefaultProfileHost,
  type HostShells,
  type TerminalPick,
  type TerminalPickHost,
} from './terminal-pick';
import { windowsBuildNumber } from '../workspace/terminal/profiles';
import { detectedProfile, profileFileKind, TerminalProfileCatalog, type LaunchProfile } from './terminal/user-profiles';
import { TerminalService, terminalSettings, terminalTabId, type TerminalGitCredentials } from './terminal/terminal-service';
import { endTerminalHostQuestion, killQuestion } from './terminal/kill-confirmation';
import { folderLinkAction, TerminalLinks, type LinkBase } from './terminal/terminal-links';
import { pasteText, TerminalPasteGate } from './terminal/terminal-paste';
import { askShellMenu, GestureGrant } from './clipboard-gestures';
import { allowYoloAsker } from './allow-host-yolo';
import { TERMINAL_LIST_DEFAULT_REM, type TerminalProfileReport, type TerminalAction, type TerminalAddToChat, type TerminalColor, type TerminalCustomIcon, type TerminalOpenLink, type TerminalOpenWebLink } from '../preload/terminal-channels';
import { capTerminalText, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES } from '../preload/terminal-attachment-cap';
import { excludeSettingGlobs } from '../workspace/search/rg-args';
import type { SearchFolder } from '../workspace/search/types';
import { createLocalWorkspace } from './workspace/local-workspace';
import { carriesTransfers, walksWithoutLinks } from './workspace/remote-workspace';
import { createWorkspaces, NotConnectedError, type Workspaces } from './workspace/workspaces';
import { RootSpellings } from './workspace/root-spellings';
import { revealAllowed, walkingBelow, withRenderedMessage } from './reveal-guard';
import type { ProjectWorkspace } from '../workspace/project-workspace';
import { SearchHost, shellSearchSettings } from './search/search-host';
import {
  installApplicationMenu,
  installedTerminalPassKeys,
  popupApplicationMenu,
  shellShortcutLabels,
  updateMenuState,
  type FocusPart,
  type MenuActions,
  type MenuState,
} from './menu';
import { createAskpassBridge, type AskCredential } from './askpass-bridge';
import { createCheckedMessageAsker, createMessageAsker, type AskCheckedMessage, type AskMessage } from './message-dialog';
import { DO_NOT_DISTURB_KEY, handleCenterChannels, NotificationCenter, runEntryAction, type ChatKey, type ChatRef, type EntryActionDeps, type StickyNotice } from './notification-center';
import { NotifierHost } from './notifier';
import { closeRemoteResult, createForgeAccountAsker, createInputAsker, createQuickPickAsker, createQuickPickManyAsker, devcontainerTrustAccepted, gitCredentialConsentChoice, OverlayHost, overlayHtml, parseCloseRemoteRequest, parseDevcontainerTrustRequest, parseGitCredentialConsentRequest, parseRect } from './overlay';
import { hostAwayOf, hostCoreFacts, lookupOnUpCore, OverlaySettings, settingsPageChat, writeDesktopSetting, type SettingsAttachTarget, type SettingsScope, type SettingsScopes } from './overlay-settings';
import { HiddenOpening } from './hidden-opening';
import type { SettingsTarget } from '../../shared/settings-sections';
import { PanelStateStore, type PersistedChat } from './panel-state-store';
import { ProjectPresences, remotePathPresence, type CheckedProject, type ProjectPresence } from './project-presence';
import { SelectionTurns } from './selection-turns';
import { restoredWorkspaceFolderKey } from '../../shared/restored-folder-key';
import { LastChats, openProjectChat } from './last-chats';
import { recordProjectSelection, recordSelection } from './selection-record';
import { chatMutationResult } from './chat-mutation-result';
import { createDesktopPlatform, type DesktopPlatform } from './platform';
import { askpassPaths, coreHostEntryPath, createDesktopAppPaths, quickOpenWorkerPath, unpackagedResourceRoot, watchWorkerPath, type DesktopLayout } from './platform/app-paths';
import type { ChatTabMessenger } from './platform/editor-service';
import { createDesktopKeyValueState, type DesktopKeyValueState } from '../local-services/key-value-state';
import { createDesktopLocalizationService, launchLanguage, readLanguageSetting, type DesktopLocalizationService } from '../local-services/localization-service';
import { createDesktopLogSinkFactory, logFileName } from '../local-services/log-sink';
import { Emitter } from '../local-services/emitter';
import { createDesktopNotificationService, type DesktopNotifications } from './platform/notification-service';
import { logUncaughtErrors } from '../local-services/process-errors';
import { ProjectList } from './projects';
import { announceInstalledVersion, ReleaseNotesSource } from './release-notes';
import { appResourceUri, handleAppProtocol, registerAppScheme, THEME_RENDER_PAGE_URL, THEME_SHOT_URL_PREFIX } from './protocol';
import { AgentThemes, type AgentThemesDeps, type ScreenshotNoticeState } from './themes/agent-themes';
import { THEME_APPLIED_TIMEOUT_MS, ThemeAcks } from './themes/theme-acks';
import { ThemeRenderer } from './themes/theme-renderer';
import { createThemeRenderSession, openThemeRenderPage, themeRenderHtml } from './themes/theme-render-page';
import { ThemeCommands } from './theme-commands';
import { keepKnownHosts } from './remote/keep-hosts';
import { readPickedFont } from './themes/font-file';
import { createAvatarCache } from './forge/avatar-cache';
import { forgeE2eServers } from './forge/e2e-forge-servers';
import { restrictPermissions, hardenWebContents } from './security';
import { chooseClientCertificate, openProbeContents, probeClientCertificates, refuseClientCertificates } from './client-certificates';
import { clientCertificateOriginOf } from '../../shared/client-certificate';
import { reportFailure, ShellHost, shellHtml, type ShellActions } from './shell';
import { mergeLoginShellEnv, probeGit, type GitProbe } from '../local-services/shell-env';
import { NO_SCM_MENU_STATE, ScmHost, type ScmWorktreeDeps } from './scm/scm-host';
import type { ScmWorktreeChat } from '../preload/scm-channels';
import { createLauncherPool, FOLDER_PROCESSES_CLOSE_MS, installProcessLauncher, lockThreadSpawns, processLauncher, runProcess, whenProcessesClosed, type Launcher } from '../../core/process-launcher';
import { allJsonConfigWritesSettled } from '../../core/config/json-config-write';
import { userConfigBase, type ConfigNotices } from '../../core/config/local-config-path';
import { createThemePathRule, type ThemePathRule } from '../../core/themes/network-rule';
import { createScmClient, type ScmClient } from './scm/scm-client';
import { SUBCALL_USAGE_LEDGER_PATH } from '../../core/paths';
import { TaskbarBadges } from './taskbar-badges';
import { TaskbarCounter } from './taskbar-counter';
import {
  currentBaseShown, decidedShown, currentDensity, currentShown, currentTextSize, currentTheme, currentThemeKind, currentThemeRevision, currentWallpaperMotion, currentWallpapers, followThemeSettings, invalidateWallpaperStats,
  namedFontBlob, namedImageBlob, onThemeChange, preferredThemeId, safeStartReason, setHeldLook, setMotionEnvironment, setSafeStart, setThemePreview, setCardTheme, clearCardThemes, projectCharacter, setWallpaperCycle, setWallpaperEnvironment,
  setWallpaperFlashReader, setWallpaperStatsReader, shownBackground, trustedBackground, wallpaperCycleChanged, currentCharacters, namedSpriteBlob, setProjectPins,
  projectLookOf, setProjectLooks, setSelectedProject,
  currentScheduleView, reevaluateTheme, renderAppearance, setAppearanceSchedule, setReportedTimeZone, setThemeClock, themeNow, themePreference,
  heldLookSettled, onThemeInputsChange, setOsKindStandIn, readPreviewRecords,
} from './theme';
import { APPEARANCE_FILE, parseAppearanceSchedule, THEME_TICK_MS } from '../../shared/themes/schedule';
import { openThemeBlob, readStoreThumb, readThemeBlob, readThemeThumb, readWallpaperFlash, readWallpaperPalette, readWallpaperStats, type NamedBlob } from './themes/theme-blobs';
import { countdownOwnerOf, readStateJson } from './themes/pending-confirm';
import { MAX_STATE_FILE_BYTES } from '../../shared/themes/limits';
import { cycleAt, ThemeState, WallpaperCycle } from './themes/theme-state';
import { isWallpaperAsset } from '../../shared/themes/wallpapers';
import { batterySaverOn } from './themes/power-saver-win32';
import { HeldTimers } from './themes/held-timers';
import { KeepFocus } from './themes/keep-focus';
import { KEEP_CHANGES_MS } from '../../shared/themes/agent';
import { overlayThemeEntry, shownChange, shownThemeName, themeCopyName, themeFilePath, ThemeLibrary } from './themes/theme-files';
import { shownKeepChanges } from './themes/keep-changes';
import { LinuxDesktopColors } from './themes/linux-desktop-colors';
import { SystemColorSource } from './themes/system-colors';
import { homeExisted, seedSystemDefault } from './themes/default-theme';
import { SAFE_THEME_FLAG } from './themes/appearance';
import { ThemeCrashLoop } from './themes/crash-loop';
import { THEME_DOCK_REM, ThemeEditorDock, type ThemeEditorRead } from './themes/editor-dock';
import { ThemeSharing } from './themes/theme-sharing';
import { THEME_LINK_SCHEME } from '../../shared/themes/theme-links';
import { THEME_ARCHIVE_EXTENSION } from '../../shared/themes/install';
import { arrangementOf, arrangementRoom, minimumScale, withArrangement } from './themes/arrangement';
import { BUILTIN_THEME_ID, SYSTEM_THEME_ID } from '../../shared/themes/builtin';
import type { SystemColors } from '../../shared/themes/system-theme';
import { MAX_FONT_BYTES } from '../../shared/themes/fonts';
import { sanitizeThemeCss, themeCssFamilies } from '../../shared/themes/css-sanitizer';
import type { Arrangement, ThemeFile } from '../../shared/themes/schema';
import { parseArrangement } from '../../shared/themes/arrangement';
import type { LookKind } from '../../shared/themes/tokens';
import { LIGHT_THEME } from '../theme-palettes';
import { AppTray } from './tray';
import { TrustStore } from './trust-store';
import { transportOutputDocument } from './host-output';
import { loadAutoUpdater, shellPlatform, UpdateService } from './updater';
import { mainWalkHost } from './walk-process';
import type { ChatWorktreeRecord, WorktreeRecord } from '../../core/worktrees/registry';
import { openWorktreeConflicts } from './worktrees/worktree-conflicts';
import { createSharedHomes } from './remote/shared-home';
import { createWatchLimits, WATCH_LIMIT_COMMAND } from './remote/watch-limit';
import { worktreeEnvironment } from '../../core/worktrees/environment';
import { worktreeEngine, type FinishHold, type WorktreeEngine } from './worktrees/engine';
import { localRecord, remoteChatRecord, WorktreeRecords } from './worktrees/records';
import { SCM_SETTING_KEYS } from '../../core/scm/settings-keys';
import type { WorktreeStateData } from '../../shared/types/messages';
import type { UserContentBlock } from '../../shared/types/content';
import { parseRootKey, rootKey } from '../preload/folder-root';
import type { ChatsWorktreeOptions, NewChatInWorktreeRequest, NewChatWorktree, ShowFolderRequest, WorktreeFinishAction, WorktreeFinishRequest } from '../preload/shell-channels';
import { RootSet, WorktreeRoots, type RootProject } from './worktrees/roots';
import { closeWorktreeRoot, type CloseOutcome } from './worktrees/close-worktree';
import { HeldPrompts } from './held-prompts';
import { KeptPermissions } from './kept-permissions';
import { releaseRemoteTerminals, removeProject, type WaitingChat } from './remove-project';
import { InterruptedLocates, locateOnce, locateProject, locateShown, preparedMove, relocationText, type LocateConfirm, type LocateOutcome, type LocatePrepared, type LocateProjectDeps } from './locate-project';
import { presentFiles, RelocatedProjects, type RelocationRequester } from './relocate-project-state';
import { addProjectAt, askToMove, type MissingProject } from './project-readd';
import type { Coded, RelocationView } from '../../core/project-relocation/types';
import { ShownFolderState } from './worktrees/shown-folder';
import { setupTaskKey, WorktreeController, type WorktreeControllerDeps } from './worktrees/worktree-controller';
import { createWorktreeDialogAsker, type AskWorktreeDialog } from './worktrees/worktree-dialogs';
import type { OverlayQuickPickItem, WorktreeDialog } from '../preload/overlay-channels';
import { remoteSetupShell, setupShell } from './worktrees/setup-terminal';
import { chatRowWorktree } from './worktrees/chat-rows';
import { UsageWarningStore } from './usage-warning-store';
import { HostStore, type HostRecord, type SshHostRecord } from './remote/host-store';
import { parseContent, RemoteState, type RemoteTerminalRecord } from './remote/remote-state';
import { startLoopbackTransport } from './remote/loopback-transport';
import { HAND_OVER_FEATURE, HAND_OVER_IF_IDLE_FEATURE, HANDING_OVER_FEATURE, type OtherProtocolDaemon, type RemoteConnection } from './remote/connection';
import { followOwnRuns } from './remote/own-runs';
import { MAX_LOG_READ_BYTES, type ClientToControl } from '../daemon/control-messages';
import { Authorities, type RemoteProject } from './remote/authorities';
import { failureOf, RemoteConnections } from './remote/connections';
import { Reconnector, type ConnectionGain, type LoopAttempt, type ReconnectEvent } from './remote/reconnect';
import { LatencyMeter } from './remote/latency';
import { HELD_MEMORY_FEATURE, RemoteHosts, sshDestination, type ConnectDialogOptions } from './remote/remote-hosts';
import {
  configuredAliases,
  controlMasterPlan,
  createMainAskpassServer,
  createRememberedSecrets,
  exitControlMaster,
  keyFolder,
  parseSshCommand,
  runSsh,
  runSshStage,
  sshEnvironment,
  sshVersion,
  sshClientChoice,
  startSshTransport,
  systemControlMasterDeps,
  systemSshTransportDeps,
  type ControlMasterDeps,
  type ControlMasterPlan,
  type RememberedOption,
  type RememberedSecrets,
  type SshDestination,
} from './remote/ssh';
import { validateInstallFolder } from './remote/bootstrap';
import { readServerManifest } from './remote/server-manifest';
import { appVersionOf, requiredOf, type ServerManifest } from './remote/server-manifest-format';
import { createSwitchReminders, switchNowText, type NoticeText } from './remote/switch-reminders';
import { createArtifactCache, releasesUrlOf, type ArtifactCache } from './remote/artifact-cache';
import { createAskpassServer, PROMPT_CANCELLED, type AskpassServer } from '../../core/scm/askpass/askpass-server';
import { asConfigParams, credentialHelperPath, managedEntries, type ManagedServer } from '../../core/scm/askpass/credential-config';
import type { PanelConnection, PanelHostAction, PanelHostLabel, PanelHostNames, PanelQueueAction } from '../preload/panel-channels';
import type { HostColor } from '../../shared/host-colors';
import type { CloseRemoteRow, CloseRemoteStatus, CloseRowHost } from '../preload/overlay-channels';
import type { Run } from '../daemon/control-messages';
import type { ChatConnection, HostReconnect } from '../../shared/host-connection';
import { registerConnectChannels } from './remote/connect-channels';
import { ForgeHost, parseForgeLinkRequest } from './forge/forge-host';
import { runForgeLink } from './forge-link-commands';
import type { ForgeLinkRequest } from '../../shared/forge/links';
import { JobLogTabs } from './forge/job-log-tabs';
import { registerForgeOverlayChannels } from './forge/forge-overlay-channels';
import { terminalManagedServers } from './forge/terminal-managed-servers';
import { authoritiesToConnectAtLaunch } from './remote/launch-connect';
import { connectionMirrorChannel, followMirrorChanges, frozenMirrorChannel, SessionMirror, type MirrorChannel } from './remote/session-mirror';
import { mirroredCopy, OfflineTranscripts } from './remote/offline-transcripts';
import { MAX_HELD_BYTES, MAX_HELD_PER_PANEL, OfflineQueue } from './remote/offline-queue';
import { e2eManifest, remoteE2eEnvironment } from './remote/remote-e2e-environment';
import { visibleLines } from '../../shared/visible-text';
import { adoptCompatibleDaemon, belowFloorSwitch, followCompatibleDaemon, followOtherProtocolDaemon, handOverIfIdle, handOverNow, otherDeviceCount, PendingSwitches, requiredDeadline, serverInUseNotice, SHUTDOWN_WHEN_IDLE_CLIENTS_FEATURE, shutDownNow, supersedes, type SwitchListing } from './remote/app-update-flow';
import { askRemoteRuns, closeRowId, CONFIGURED_PROVIDERS_FEATURE, listHostRuns, type CloseWithRunningAgents, type HostRuns } from './remote/close-remote';
import { CloseRelease } from './close-release';
import { announceFinishedAway, awayChats } from './remote/finished-away';
import { keepRunningAtShutdown, startKeepRunningRefresh, type KeepRunningDeps, type KeepRunningHost } from './remote/keep-running-refresh';
import { authorityOsOf, forwardsAgent, groupsOf, hostIdOfAuthority, hostOs, offersAgentForwarding } from './remote/host-store';
import { AgentRelays, localAgentPath } from './remote/agent-relay';
import { containerNameRefusedText, notContainerProjectText } from './remote/container-texts';
import { forgetHostData } from './remote/forget-host-data';
import { listWslDistros } from './remote/wsl/wsl-list';
import { startWslTransport } from './remote/wsl/wsl-transport';
import { acceptedWithin, probeLoopback, systemWindowsListeners } from './remote/wsl/wsl-port-probe';
import { reopenInWsl, wslpathInDistro, type OpenInDistroDeps, type ReopenDeps } from './remote/wsl/reopen-in-wsl';
import { linuxToWslUnc, wslUncToLinux } from './remote/wsl/wsl-paths';
import { wslNetworkingMode } from './remote/wsl/wsl-list';
import { systemSetVersion } from './remote/wsl/convert-to-wsl2';
import { connectContainer, passGate } from './remote/containers/container-connect';
import { localContainerSide, viaContainerSide, type ContainerSide } from './remote/containers/container-side';
import { DevcontainerConfigs } from './remote/containers/devcontainer-configs';
import { devcontainerReadConfiguration } from './remote/containers/devcontainer';
import { upContainer } from './remote/containers/container-connect';
import { runDevcontainerTrustGate, type DevcontainerTrustVerdict } from './remote/containers/devcontainer-trust';
import { devcontainersCliPath } from './platform/app-paths';
import type { ContainerHostRecord } from './remote/host-store';
import type { EditorOpenLink, ProjectLookResult, ReopenInContainerResult } from '../preload/shell-channels';
import type { ProjectLookImageResult } from '../preload/overlay-channels';
import { FILES_CONFIRM_DRAG_AND_DROP_SETTING, FILES_CONFIRM_PASTE_NATIVE_SETTING, REMOTE_CONTAINER_ENGINE_SETTING, REMOTE_SSH_PATH_SETTING } from '../local-services/desktop-configuration';
import { openAsProject, openFolderAsProject, type OpenAsProjectDeps } from './open-as-project';
import { waitForRemoteFolderConnection } from './e2e-open-folder';
import { RELOCATE_FEATURE, RemoteCore, type RemoteHostedCore } from './remote/remote-core';
import { remoteRelocation } from './remote/relocate-remote-project';
import { clientGitCredential, createGitCredentialClient, type GitCredentialClient } from './remote/git-credential-client';
import { keptChatFate, oncePerConversation, reopenKeptChat } from './remote/kept-remote-chats';
import { remoteServices } from './remote/remote-services';
import { chatOfSelectedProject, keptChatWithheld, remoteSelection } from './remote/remote-selection';
import type { RemoteChatRecord } from './remote/remote-state';
import type { DesignMarkupSendRequest, DesignMarkupSent, DesignTweakKeepRequest, OpenAsProjectRequest, OpenAsProjectResult, ProjectsView, ShellEngine, ShellHost as SavedShellHost } from '../preload/shell-channels';
import type { HostServicesDeps, HostTrust } from './core-services/host-services';
import { ERROR_PAGE_STRINGS } from '../../shared/panel-html';
import { createProjectTrust, createRemoteTrust, remoteHostTrust, type HostTrustFolder, type RemoteTrustTarget } from './remote/remote-trust';
import { addRemoteProjectAt } from './remote/remote-project-add';
import { TrustPending } from './remote/trust-pending';
import { authorityKeyOfProject, isAbsoluteOn, isInsideFolder, pathFor, projectKeyOf, targetFolderKeyOf, type Authority } from '../../shared/project-location';
import { CREDENTIAL_ORIGIN_FEATURE } from '../../shared/git-credential';
import { projectOfCwd, remoteFileRef, type RemoteFileRoot } from './remote/remote-files';
import { visibleText } from '../../shared/visible-text';
import { crossedByMention, crossedByViewMessage, ownRemoteDrop, type AuthorityMentionTarget } from './mention-authority';
import { UserRelays, relayedUserSettingKeys } from './remote/user-relays';
import { ForeignViewRelay } from './remote/foreign-view-relay';
import { LOOPBACK_HOST, PortsController } from './remote/ports/ports-controller';
import { relayBrowserTool, typedRemoteAddress } from './remote/browser-relay';
import { hostProjectOf, relayForgeDescribe, relayForgeTool, type ForgeRelayDeps } from './remote/forge-relay';
import { allowRelayedInstallFlash, RelayedConsents, RelayedInstalls, RelayedPreviews, relayTheme, tellShotGone, type RelayedShotsDeps, type ThemeRelayDeps } from './remote/theme-relay';
import { rewriteOutbound } from './remote/ports/url-rewrite';
import { memoryDocument } from './platform/editor-document';
import type { HostDiffView } from './platform/editor-service';
import type { DiffRequest, DiffSide } from '../../platform/editor-service';
import type { EditorDocument } from '../../shared/types/messages';
import { readContributedConfiguration } from '../../core/config/read-contributed-configuration';
import { desktopHostCapabilities } from '../local-services/capabilities';
import { PanelViews, type DesktopPanel, type PageStrings, type ShowFocus } from './views';
import {
  boundsToPersist,
  clampToWorkAreas,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  defaultWindowBounds,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WindowLayoutStore,
  type AppliedBounds,
  type Rect,
} from './window-layout-store';

// electron-builder.yml appId: the Windows AppUserModelID, the macOS bundle id and the update identity. The unpackaged app's own
// ID keeps its taskbar button group, and any Start Menu shortcut or pin carrying that ID, apart from an installed copy's.
const APP_ID = app.isPackaged ? 'io.github.aizenvoltprime.damocles' : 'io.github.aizenvoltprime.damocles.dev';
// The packaged package.json name. The unpackaged app sets it too, or Electron names it "Electron" and it shares its
// userData folder and safeStorage key with every other unpackaged Electron app.
// The unpackaged app never shares userData, the safeStorage key or the single-instance lock with an installed copy.
const APP_NAME = app.isPackaged ? 'damocles' : 'damocles-dev';
const DISPOSE_TIMEOUT_MS = 10_000;
// within DISPOSE_TIMEOUT_MS: the wait for the window to close and its pages' requests to settle
const CLOSE_TIMEOUT_MS = 3_000;
// within DISPOSE_TIMEOUT_MS: the store flush's wait for the work the quit joined
const QUIT_JOIN_WAIT_MS = 3_000;
// characters of a Files transfer's details in its dialog, under the overlay's MAX_OVERLAY_TEXT_LENGTH
const MESSAGE_DETAIL_BUDGET = 1800;
const CHAT_PANEL: PanelOptions = { kind: 'chat', title: 'Damocles', localResourceRoots: [] };
// Playwright's hooks (globalThis.__damoclesE2e and core's e2e.* requests), in the unpackaged app only.
const E2E_HOOKS = !app.isPackaged && process.env['DAMOCLES_E2E_HOOKS'] === '1';
// The GPU process's first report of the run: getGPUFeatureStatus() answers software until then. Listened for from here so a
// test cannot miss it.
const E2E_GPU_REPORTED = E2E_HOOKS ? new Promise<void>((resolve) => app.once('gpu-info-update', () => resolve())) : undefined;
// The loopback authority (a local folder through a daemon this app starts), in the unpackaged app only.
const LOOPBACK = !app.isPackaged && (E2E_HOOKS || process.env['DAMOCLES_LOOPBACK'] === '1');
// The ssh config and release URL e2e runs point the transport at (dev builds with the e2e hooks only).
const SSH_ENVIRONMENT = sshEnvironment({ packaged: app.isPackaged, env: process.env });
const REMOTE_E2E = remoteE2eEnvironment({ packaged: app.isPackaged, env: process.env });
const FORGE_E2E_SERVERS = forgeE2eServers({ packaged: app.isPackaged, env: process.env });
// The folder core reads https://e2e.test/<name> theme downloads from (unpackaged with the e2e hooks only; every check still runs).
const THEME_E2E_DOWNLOADS = E2E_HOOKS ? process.env['DAMOCLES_E2E_THEME_DOWNLOADS'] : undefined;
// The community store list core reads in its place, https://e2e.test/<name> from that folder, and the test key it is signed
// with (unpackaged with the e2e hooks only; the list is verified as any other).
const THEME_E2E_STORE = (() => {
  const listUrl = E2E_HOOKS ? process.env['DAMOCLES_E2E_THEME_STORE_LIST'] : undefined;
  const publicKeyPem = E2E_HOOKS ? process.env['DAMOCLES_E2E_THEME_STORE_KEY'] : undefined;
  return listUrl !== undefined && publicKeyPem !== undefined && THEME_E2E_DOWNLOADS !== undefined ? { listUrl, publicKeyPem } : undefined;
})();
// how often a pending switch asks the old daemon for its runs (and a daemon of another protocol for its mirror) when it pushes
// no runs events: a daemon without control.runs, or one of another protocol, whose frozen commands carry no events
const SWITCH_POLL_MS = 5000;
// the window an OS shutdown or an update's quit gives the token pushes, inside the quit's own bound
const UNATTENDED_PUSH_MS = 3000;
// the daemon ends a connection at once on control.disconnect
const DISCONNECT_FEATURE = 'control.disconnect';
const LIST_OWN_RUNS_FEATURE = 'control.listOwnRuns';
// each wait of a quit's detach from its daemons (a mirror sync, the disconnect), inside DISPOSE_TIMEOUT_MS
const REMOTE_DETACH_WAIT_MS = 3000;
// a quit's wait for the running file transfers to stop and remove their parts, before the teardown's own bound starts
const TRANSFER_CANCEL_WAIT_MS = 3000;
const VERIFIED_ERASE_FEATURE = 'askpass.credential.verifiedErase';
// the preview reads a remote design only through these (design.read, design.info)
const DESIGN_PREVIEW_FEATURES: readonly string[] = ['design.read', 'design.info'];

// A remote chat's status in the close dialog, from its activity.
function closeStatusOf(activity: ChatActivity): CloseRemoteStatus {
  if (activity.pendingKinds.includes('signIn')) return 'signIn';
  if (activity.state === 'requires_action') return 'waiting';
  return activity.state === 'running' || activity.background ? 'running' : 'idle';
}
// The client id every daemon names this install by, in userData's global state.
const REMOTE_CLIENT_ID_KEY = 'damocles.remote.clientId';
// The daemon's own log in its run folder's logs/ (daemon/token.ts runPaths) on its host, which logs.read serves by name.
const DAEMON_LOG = 'daemon.log';
const BROWSER_ENABLED_KEY = 'damocles.browser.enabled';
// What a shell call answers once main has reported its failure to the user.
const CHAT_CHANGE_FAILED: ChatMutationResult = { ok: false, reason: 'failed' };
const OVERLAY_DISMISSED: OverlayAnswer = { kind: 'dismissed' };

// What an install on a target needs from this app, read on the first connect.
interface ServerInstall {
  readonly manifest: ServerManifest;
  readonly artifacts: ArtifactCache;
  // absent for an unpublished build, whose hosts never download
  readonly releasesUrl?: string;
  readonly askpass: AskpassServer;
}

function runtimeProblem(): string | undefined {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) return `Damocles needs Electron's Node 24 runtime, but this build runs Node ${process.versions.node}.`;
  if (process.getBuiltinModule('node:sqlite') === undefined) return 'The node:sqlite module is not available in this Electron build, and memory, usage and Compass need it.';
  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isShellTag(tag: string | undefined): tag is string {
  return tag !== undefined && tag.trim().length > 0 && tag.length <= MAX_TAG_LENGTH;
}

function shellDesignOf(row: StoredSession): ShellChat['design'] {
  if (!row.design) return undefined;
  const { parentSessionId, finishedVersion, superseded } = row.design;
  return {
    ...(parentSessionId !== undefined ? { parentId: parentSessionId } : {}),
    ...(finishedVersion !== undefined ? { finishedVersion } : {}),
    ...(superseded === true ? { superseded } : {}),
  };
}

// The one check of a design file a core names: a design id and a relative path with no Windows-unsafe segment; a `page` is
// any .html below the design (a render), a `screen` is screens/<name>.html (a replay).
function designTargetOf(authority: string, designId: string, relPath: string, kind: 'file' | 'page' | 'screen'): DesignViewTarget {
  const file = isDesignId(designId) && isRelativeFilePath(relPath) && !hasUnsafeWindowsSegment(relPath);
  if (kind === 'file' && !file) throw new Error('Not a design file');
  if (kind === 'page' && !(file && relPath.toLowerCase().endsWith('.html'))) throw new Error('Not a design screen');
  if (kind === 'screen' && !(file && isDesignScreenFile(relPath))) throw new Error('Not a design screen');
  return { authority, designId };
}

function windowStateOf(window: BrowserWindow | undefined): ShellWindowState {
  if (!window || window.isDestroyed()) return 'normal';
  if (window.isFullScreen()) return 'fullScreen';
  return window.isMaximized() ? 'maximized' : 'normal';
}

// Position and content size: getBounds reads a frameless Windows window a DIP larger than setBounds made it at 150%
// (electron/electron#51572), its content size exactly.
function normalBoundsOf(window: BrowserWindow): Rect {
  const [x = 0, y = 0] = window.getPosition();
  const [width = 0, height = 0] = window.getContentSize();
  return { x, y, width, height };
}

// The bounds main applied to a window and its last read while neither maximized, minimized nor full screen.
interface WindowBoundsTracker {
  applied: AppliedBounds | undefined;
  normal: Rect;
}

// Every placement main makes ends here, once the window is at `bounds`' position: the constructor and setBounds size a
// frameless Windows window up to 4 DIP off its request at 150% (electron/electron#51572), and setContentSize sizes it exactly.
function sizeExactly(window: BrowserWindow, bounds: Rect, tracker: WindowBoundsTracker): void {
  window.setContentSize(bounds.width, bounds.height);
  const read = normalBoundsOf(window);
  tracker.applied = { bounds, read };
  tracker.normal = read;
}

// Read on every save as well as on 'resize' and 'move': X11 applies setBounds asynchronously, so those events can carry the
// new position with the old size, and Linux emits no 'resized' or 'moved' to correct it.
function refreshNormalBounds(window: BrowserWindow, tracker: WindowBoundsTracker): void {
  if (!window.isMaximized() && !window.isMinimized() && !window.isFullScreen()) tracker.normal = normalBoundsOf(window);
}

// A chat's worktree state as PanelManager.onDidChangeWorktreeState reports it.
interface WorktreeEvent {
  readonly panelId: string;
  readonly sessionId?: string;
  readonly projectPath: string;
  readonly worktreeId?: string;
  readonly workingFolder: string;
  readonly state: WorktreeStateData;
  readonly busy: boolean;
}

// What a remote host's terminals start with and give xterm, as its connection's workspace answered.
interface HostTerminals {
  readonly workspace: ProjectWorkspace | undefined;
  profiles: readonly LaunchProfile[];
  windowsBuild: number | null;
  detected: Promise<void>;
  // detected has settled
  ready: boolean;
}

// A core a chat runs on: the local one, or a remote authority's attached over its daemon.
interface ChatCore {
  readonly authority: string;
  readonly client: CoreClient;
  // false once the core stopped serving (it ended, or its attach did)
  isReady(): boolean;
  // a remote core: a view joins a panel its core holds (RemoteHostedCore.rejoin)
  readonly rejoin?: RemoteHostedCore['rejoin'];
}

// What Locate reads and runs on the project's own machine and core.
type LocatePlace = Pick<LocateProjectDeps, 'project' | 'presence' | 'listed' | 'pathPresence' | 'pathFlavor' | 'pickFolder' | 'preflight' | 'askTrust' | 'holdTrust' | 'closeChats' | 'relocate'>;

interface ChatCoreHost {
  run<T>(label: string, work: (core: ChatCore) => T | Promise<T>): Promise<T>;
  read<T>(label: string, work: (core: ChatCore) => T | Promise<T>): Promise<T>;
  current(): ChatCore | undefined;
  halted(): boolean;
}

// Core panel ids are per core (host-1, host-2, ...), so main's maps name a remote chat by its authority too.
const CHAT_KEY_SEPARATOR = '|';

function chatKey(authority: string, corePanelId: string): string {
  return authority === 'local' ? corePanelId : `${authority}${CHAT_KEY_SEPARATOR}${corePanelId}`;
}

function parseChatKey(key: string): { readonly authority: string; readonly corePanelId: string } {
  const at = key.indexOf(CHAT_KEY_SEPARATOR);
  return at < 0 ? { authority: 'local', corePanelId: key } : { authority: key.slice(0, at), corePanelId: key.slice(at + 1) };
}

function statusOf(activity: ChatActivity | undefined): ChatStatus {
  if (activity?.state === 'requires_action') return 'waiting';
  return activity?.state === 'running' || activity?.background === true ? 'running' : 'idle';
}

const layout: DesktopLayout = app.isPackaged
  ? { packaged: true, asarPath: app.getAppPath() }
  : { packaged: false, repoRoot: unpackagedResourceRoot(__dirname) };
const resourceRoot = layout.packaged ? layout.asarPath : layout.repoRoot;

class DesktopApp {
  private readonly userDataDir = app.getPath('userData');
  private readonly themesOwner = countdownOwnerOf(this.userDataDir);
  private readonly logsDir = path.join(this.userDataDir, 'logs');
  // D36: Show Log opens a log sink's file as a read-only editor tab.
  // account pictures of this computer's core's Git hosting accounts, served by the app protocol
  private readonly forgeAvatars = createAvatarCache(async (key) => (await this.client()?.forgeAvatar(key)) ?? undefined);
  private readonly logSinks = createDesktopLogSinkFactory(this.logsDir, !app.isPackaged, (filePath, preserveFocus) => this.openLogTab(filePath, preserveFocus));
  private readonly logSink = this.logSinks.create(MAIN_LOG_NAME);
  private readonly states: PanelStateStore;
  private readonly windowLayout: WindowLayoutStore;
  private readonly projects: ProjectList;
  private readonly state: DesktopKeyValueState;
  private readonly trust: TrustStore;
  private readonly usageWarnings: UsageWarningStore;
  // each look's wallpaper set (theme-state.json)
  private readonly themeState: ThemeState;
  // the e2e hooks' record of theme blob answers, and the motion inputs they pin
  private readonly servedThemeBlobs: Array<{ readonly sha256: string; readonly status: number; readonly contentRange: string | null }> = [];
  // the characters the overlay and the notifier were last told of, as JSON
  private overlayCharacters = 'null';
  private pinnedMotion: Parameters<typeof setMotionEnvironment>[0] = {};
  // the shell page's document.visibilityState as it last reported it (SHELL_CHANNELS.pageMotion)
  private shellPageVisible = true;
  // an e2e run's regional format, since app.getSystemLocale() is the machine's
  private pinnedSystemLocale: string | undefined;
  // an e2e run that set the schedule's clock fires the theme tick itself (themeTick)
  private themeTickHeld = false;
  // read in start(), before anything lists a project
  private hostStore: HostStore | undefined;
  private ports: PortsController | undefined;
  private portsView: Disposable | undefined;
  // this device's SSH agent relayed to the containers whose switch forwards it
  private agentRelays: AgentRelays | undefined;
  private remoteState: RemoteState | undefined;
  // remote chat pages' sends held while their host is away, made with remoteState
  private offlineQueue: OfflineQueue | undefined;
  // the connections whose device list the host cards follow
  private readonly devicesWatched = new WeakSet<RemoteConnection>();
  // the connections whose terminals.responding events main follows
  private readonly respondingWatched = new WeakSet<RemoteConnection>();
  // each authority's pending server switch, of either protocol, which every update surface reads
  private readonly pendingSwitches = new PendingSwitches();
  // each authority's reminders of its pending switch, the countdown of a required one and what a sent switch stopped
  private readonly switchReminders = createSwitchReminders({
    wording: (authority) => {
      const localization = this.requireLocalization();
      // the clock the strip, card and tag show, in the app's language
      const clock = clockFormatter(localization.language);
      return { t: (message, ...args) => localization.t(message, ...args), hostName: this.hostName(authority), time: (at) => clock.format(at), now: Date.now() };
    },
    remind: (authority, notice) => this.remindOfSwitch(authority, notice),
    countDown: (authority, notice, deadline) => this.countDownToSwitch(authority, notice, deadline),
    switched: (authority, notice, forced) => {
      const host = this.notificationHost(authority);
      // the forced one breaks through Do not disturb; the one the user chose follows it
      const shown = forced
        ? this.notificationCenter.notice(notice.severity, notice.message, [], host, notice.title, { timeSensitive: true })
        : this.notificationCenter.hostUpdate(host, notice.severity, notice.title, notice.message, []);
      shown.catch(this.report('Showing what the switch stopped'));
    },
    log: (line) => log(line),
  });
  // the 15 minutes a connect that found a required deadline passed gave its daemon, kept for the run so a reconnect adds none
  private readonly missedDeadlines = new Map<string, { readonly serverVersion: string; readonly deadline: number }>();
  // the connections of older daemons this app uses as they are because other computers use them (the serverInUse notice)
  private readonly olderInUse = new WeakSet<RemoteConnection>();
  // the connections a switch brought, whose restart the switch's own notice tells instead of hostRestarted
  private readonly switchTold = new WeakSet<RemoteConnection>();
  // the remote agents', terminals' and editors' questions of a close or quit; lifecycle.release shares one among every caller
  private readonly closeRelease = new CloseRelease({
    remote: (unattended) => askRemoteRuns(this.closeRemoteDeps(), unattended),
    terminals: async () => {
      const terminals = this.terminals;
      return !terminals || terminals.confirmKill(terminals.quitIds());
    },
    editors: () => this.editorPane?.release() ?? Promise.resolve(true),
  });
  // a remote chat's status for the close dialog, while it is open
  private readonly remoteStatusListeners = new Set<(authority: string, panelId: string, status: CloseRemoteStatus) => void>();
  // each remote chat's latest activity by its stored session (authority\nsessionId), for chats this window has not loaded
  private readonly sessionActivity = new Map<string, ChatActivity>();
  // a host's attempt or notices changed, for the close dialog's logout warning
  private readonly hostNoticeListeners = new Set<(hostId: string) => void>();
  // by authority, the connection state each remote chat page last heard
  private readonly sentChatConnection = new Map<string, string>();
  private authorities: Authorities | undefined;
  private remoteConnections: RemoteConnections | undefined;
  // when a dropped or failed authority with open views is attempted again, and its connection quality
  private reconnector: Reconnector | undefined;
  private latency: LatencyMeter | undefined;
  // each SSH host's master connection plan, read with ssh -G at each attempt and each removal stage
  private readonly controlPlans = new Map<string, ControlMasterPlan>();
  private serverInstallRead: Promise<ServerInstall> | undefined;
  // What an install needs, read once on the first connect: the server manifest, the artifact cache for the upload fallback
  // and main's askpass server for ssh's prompts. A failed read is tried again at the next connect.
  private readonly serverInstall = (): Promise<ServerInstall> => {
    if (this.serverInstallRead === undefined) {
      const read = this.readServerInstall();
      this.serverInstallRead = read;
      read.catch(() => {
        if (this.serverInstallRead === read) this.serverInstallRead = undefined;
      });
    }
    return this.serverInstallRead;
  };
  // the e2e hooks hold a cut transport down until released
  private readonly heldTransports = new Set<string>();
  private remoteHosts: RemoteHosts | undefined;
  // main's askpass server for ssh's prompts, made on the first connect
  private sshAskpass: AskpassServer | undefined;
  // main's askpass server for local terminals' git credential requests, which the local core answers; made on the first spawn
  private terminalAskpass: AskpassServer | undefined;
  // the servers the last ready core named as managed, so a terminal started while core restarts still hands git to Damocles
  private managedServers: readonly ManagedServer[] = [];
  // remembered ssh answers: one per process, so a host's store never lands after its deletion
  private sshRememberedSecrets: RememberedSecrets | undefined;
  private gitCredentials: GitCredentialClient | undefined;
  // each SSH host's session mirror, made the first time it is used
  private readonly sessionMirrors = new Map<string, SessionMirror>();
  // the read-only transcripts of remote chats whose host was not connected at launch
  private readonly transcripts = new OfflineTranscripts<DesktopPanel>({
    mirrored: async (authority, sessionId) => {
      const hostId = this.savedHostIdOf(authority);
      if (hostId === undefined) return undefined;
      const mirror = this.sessionMirrorOf(hostId);
      const held: Array<{ readonly projectKey: string; readonly file: string }> = [];
      for (const project of this.remoteProjects().filter((candidate) => candidate.authorityKey === authority)) {
        const file = await mirror.sessionFile(project.folderKey, sessionId);
        if (file !== undefined) held.push({ projectKey: project.key, file });
      }
      const copy = await mirroredCopy(held, async (projectKey) => (await this.mirroredRows(projectKey, ''))?.some((row) => row.id === sessionId) === true);
      if (!copy) log(`[mirror ${hostId}] holds no copy of the saved chat ${sessionId}`);
      return copy;
    },
    connected: (authority) => this.authorities?.connection(authority) !== undefined,
    create: (authority, sessionId, projectKey, panelToken) => {
      const view = this.requireViews().create({ options: CHAT_PANEL, restore: { panelId: randomUUID(), state: { sessionId } }, authority, offline: { hostId: this.hostIdOf(authority), hostName: this.hostName(authority) }, ...(panelToken !== undefined ? { heldFor: panelToken } : {}) });
      this.trackChat(view, projectKey);
      return view;
    },
    load: (view, authority, file) => this.core.run('Open a mirrored transcript', (core) => core.client.openTranscript(view, this.hostIdOf(authority), file)),
    selected: () => this.views?.selected(),
    version: async (file) => {
      const stat = await fs.promises.stat(file).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      });
      return stat === undefined ? undefined : `${stat.size}:${stat.mtimeMs}`;
    },
    reload: (view) => view.restart(),
    chatViewFree: () => !this.views?.selected() || this.chatElsewhereSelected(),
    select: (view) => this.showChat(view, { focus: 'whenReady' }),
  });
  // each remote authority's core, made the first time the authority connects and kept across reconnects
  private readonly remoteCores = new Map<string, RemoteCore>();
  private readonly remoteSelection = remoteSelection({
    selectedProject: () => this.selectedProjectKey,
    selectedChat: () => this.views?.selected(),
    host: (authority) => this.remoteCores.get(authority)?.host,
    showProject: (key, userStarted) => {
      const project = this.remoteProject(key);
      if (!project) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
      // a connection that is not up is tried again
      this.connectAuthority(project.authorityKey, userStarted);
      if (key === this.selectedProjectKey) return;
      this.selectedProjectKey = key;
      const saved = this.remoteState?.selected();
      this.remoteState?.select({ projectKey: key, ...(saved?.projectKey === key && saved.sessionId !== undefined ? { sessionId: saved.sessionId } : {}) }).catch(this.report('Saving the remote selection'));
      this.search?.stopAll();
      this.scm?.selectedProjectChanged();
      this.terminals?.publish();
      this.shownFolders.refresh();
      this.chatsChanged(key);
      this.refreshMenuState();
      this.shellStateChanged();
    },
    selectChatOf: (core, key) => this.selectProjectIn(core, key),
  });
  private remoteTrust: ReturnType<typeof createRemoteTrust> | undefined;
  private projectTrust: ReturnType<typeof createProjectTrust> | undefined;
  // authorities whose kept terminals this window reattached, and the list last saved for each
  private readonly reattachedAuthorities = new Set<string>();
  private readonly savedRemoteTerminals = new Map<string, string>();
  // each remote host's own shells and Windows build, asked on every connect; the last answer stays while the host is away
  private readonly hostTerminals = new Map<string, HostTerminals>();
  // authorities whose saved chats this run reopened, and the chat list last saved for each
  private readonly reopenedRemoteChats = new Set<string>();
  private readonly savedRemoteChats = new Map<string, string>();
  // the local chat a remote chat's settings User tab attaches to opens hidden
  private readonly settingsOpening = new HiddenOpening<DesktopPanel>((chat) => this.corePanelIdOf(chat));
  // that local chat, which retention keeps while the settings show
  private settingsLocalChat: DesktopPanel | undefined;
  // the page token of the remote chat selected when its authority's core went, by authority
  private readonly reselectRemote = new Map<string, string>();
  // Every desktop question: the overlay's dialog, else the OS message box (D41).
  private readonly askMessage = createMessageAsker({
    overlay: () => this.overlay,
    window: () => this.window,
    focused: () => webContents.getFocusedWebContents() ?? undefined,
    closing: () => this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'done',
    log: (line) => log(line),
  });
  // the same dialog with a checkbox ("Don't ask again", "Apply to all remaining conflicts")
  private readonly askChecked: AskCheckedMessage = createCheckedMessageAsker({
    overlay: () => this.overlay,
    window: () => this.window,
    focused: () => webContents.getFocusedWebContents() ?? undefined,
    closing: () => this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'done',
    log: (line) => log(line),
  });
  // A close or quit asks in a window it shows first, since one hidden to the tray or minimized hides the question.
  private readonly ask: AskMessage = (question, signal) => {
    if (this.lifecycle.releasing) this.revealWindow();
    return this.askMessage(question, signal);
  };
  private readonly lifecycle = new QuitLifecycle({
    // a relaunch tries the user's theme again and handles no link or command line request twice (relaunchArgs)
    app: {
      quit: () => app.quit(),
      relaunch: () => app.relaunch({ args: relaunchArgs(process.argv) }),
      once: (event, listener) => app.once(event, listener),
      removeListener: (event, listener) => app.removeListener(event, listener),
    },
    release: () => this.closeRelease.release(),
    dispose: () => this.disposeAll(),
    log: (line) => log(line),
  });
  // D52: the taskbar badge, drawn by the overlay page.
  private readonly taskbarBadges = new TaskbarBadges({
    rasterize: (art) => this.overlay?.rasterize(art) ?? Promise.resolve(undefined),
    scaleFactor: () => screen.getPrimaryDisplay().scaleFactor,
    // White on red in every theme; the light palette's pair is the one at AA.
    colors: { fill: LIGHT_THEME['--d-danger']!, text: LIGHT_THEME['--d-on-danger']! },
    log: (line) => log(line),
  });
  // D52: popups in a window of the app's own outside the main window, which the OS notification settings do not hold back.
  private readonly notifier: NotifierHost = new NotifierHost({
    platform: process.platform,
    preloadPath: path.join(__dirname, 'preload-overlay.js'),
    state: () => this.overlayState(),
    // A popup's action brings the window forward before it runs, except a link's Open, whose browser comes forward instead.
    resolveToast: (id, action) => {
      if (action !== undefined && !this.notificationCenter.isLinkRequest(id)) this.showWindow();
      this.notificationCenter.resolveToast(id, action);
    },
    copyToast: (id) => this.notificationCenter.copyLink(id),
    holdToast: (id, held) => this.notificationCenter.holdToast(id, held),
    leave: () => this.leavePopups(),
    blurred: () => {
      this.toastFocusOrigin = undefined;
    },
    pendingToasts: () => this.notificationCenter.pendingToasts(),
    log: (line) => log(line),
  });
  // reached lazily, since the platform is made after the theme fields that take this
  private readonly themeNotices: ConfigNotices = { warn: (message, actions, options) => this.requirePlatform().notifications.warn(message, actions, options) };
  // main's own network rule for the theme files, never core's verdict
  private readonly themeFiles: ThemePathRule = createThemePathRule(THEMES_DIR, this.themeNotices);
  // the agent's theme tools: previews and screenshots, the keep-changes banner, a card's Show in window (main/themes/agent-themes.ts)
  private readonly themeRenderer = new ThemeRenderer({
    openPage: (gone) => openThemeRenderPage(THEME_RENDER_PAGE_URL, gone),
    readBlob: async (sha256, mime, kind) => (await readThemeBlob(THEMES_DIR, sha256, () => ({ kind, mime }), (sha) => this.themeLibrary?.packedAsset(sha), this.themeNotices))?.bytes,
    // the editor's import and the install cards that wait on the check, which core knows
    progress: (sha256, fraction) => {
      this.themeDock?.importProgress(fraction);
      this.client()?.themesAnalyzeProgress(sha256, fraction).catch((err: unknown) => log(`[themes] the install cards were not told a flash check's progress: ${err instanceof Error ? err.message : String(err)}`));
    },
    log: (line) => log(line),
  });
  private readonly relayedPreviews = new RelayedPreviews({
    features: (authority) => this.authorities?.connection(authority)?.features,
    send: async (authority, ended) => this.requireRemoteCore(authority).client.themeShowEndedRemote(ended),
    log: (line) => log(line),
  });
  private readonly relayedConsents = new RelayedConsents({
    now: () => Date.now(),
    // main is the one publisher of a remote chat's grant to its page; a post of its core's is dropped (REMOTE_CORE_REFUSED_POSTS)
    publishGrant: (panelId, granted) => {
      void this.views?.panel(panelId)?.postMessage({ type: 'themeScreenshotGrant', granted });
    },
    captureTheme: (captureId, theme) => setCardTheme('relayed', captureId, theme),
    pageSession: (panelId) => {
      const panel = this.views?.panel(panelId);
      return panel ? this.sessionIdOf(panel) : undefined;
    },
    log: (line) => log(line),
  });
  // the e2e hooks' hold on the wait for those revisions, so a slow runner's capture waits for its pages (DAMOCLES_E2E_HOOKS,
  // unpackaged only)
  private readonly themeAckTimers = E2E_HOOKS ? new HeldTimers() : undefined;
  // the theme revisions the shell and the chat views painted, which a draft capture waits on
  private readonly themeAcks = new ThemeAcks({
    revision: () => currentThemeRevision(),
    ...(this.themeAckTimers ? { setTimer: this.themeAckTimers.setTimer, clearTimer: this.themeAckTimers.clearTimer } : {}),
  });
  private readonly relayedShots: RelayedShotsDeps = {
    features: (authority) => this.authorities?.connection(authority)?.features,
    send: async (authority, shotId) => this.requireRemoteCore(authority).client.themeScreenshotGoneRemote(shotId),
    log: (line) => log(line),
  };
  private readonly relayedInstalls = new RelayedInstalls({
    features: (authority) => this.authorities?.connection(authority)?.features,
    sendUpdated: async (authority, preview) => this.requireRemoteCore(authority).client.themeInstallUpdatedRemote(preview),
    sendProgress: async (authority, progress) => this.requireRemoteCore(authority).client.themeInstallProgressRemote(progress),
    sendExpired: async (authority, installId) => this.requireRemoteCore(authority).client.themeInstallExpiredRemote(installId),
    log: (line) => log(line),
  });
  // the e2e hooks' hold on the keep-changes countdown, which a test then ends itself (DAMOCLES_E2E_HOOKS, unpackaged only)
  private readonly keepChangesTimers = E2E_HOOKS ? new HeldTimers() : undefined;
  // the e2e hooks' hold on the screenshot notice's timer, and every notice raised since launch (DAMOCLES_E2E_HOOKS, unpackaged only)
  private readonly screenshotNoticeTimers = E2E_HOOKS ? new HeldTimers() : undefined;
  private readonly raisedScreenshotNotices: ScreenshotNoticeState[] = [];
  private readonly agentThemes: AgentThemes = new AgentThemes({
    root: THEMES_DIR,
    owner: this.themesOwner,
    notices: this.themeNotices,
    renderer: this.themeRenderer,
    shotUrlPrefix: THEME_SHOT_URL_PREFIX,
    captureWindow: () => this.captureWindowForTheme(),
    chatSlot: () => {
      const chat = this.views?.inSlot();
      if (!chat || !chat.view.getVisible()) return undefined;
      const session = this.sessionIdOf(chat);
      return { origin: chat.authority, ...(session !== undefined ? { session } : {}) };
    },
    windowState: () => {
      const window = this.window;
      if (!window || window.isDestroyed()) return 'none';
      if (window.isMinimized() || !window.isVisible()) return 'hidden';
      // Chromium's occlusion tracking marks a window another app covers whole as hidden to its page
      return this.shellPageVisible ? 'shown' : 'covered';
    },
    readPreviewRecords: (preview) => readPreviewRecords(preview),
    themeApplied: (signal) => {
      const window = this.window;
      if (!window || window.isDestroyed()) return Promise.resolve(false);
      const chat = this.views?.inSlot();
      const pages = [window.webContents, ...(chat?.view.getVisible() ? [chat.webContents] : [])];
      return this.themeAcks.until(pages, signal);
    },
    revokeGrant: async (origin, chat) => {
      if (origin !== 'local') {
        this.relayedConsents.revoke(origin, chat);
        return;
      }
      // a local grant lives in the memory of this computer's core, so with no core running it has already ended
      await this.client()?.themesScreenshotGrantRevoke(chat);
    },
    noticeNames: (origin, session) => this.screenshotNoticeNames(origin, session),
    noticeFocusLeft: () => {
      const part = this.noticeFocus.ended(true, 'chat');
      if (part !== undefined) this.focusOn(part);
    },
    core: {
      keep: (entryId) => this.requireLocalClient().themesKeep(entryId),
      revert: async (entryId) => {
        const { undone, arrangement } = await this.requireLocalClient().themesUndoPending(entryId);
        return { reverted: undone !== undefined, ...(arrangement !== undefined ? { arrangement } : {}) };
      },
      // a remote card's end goes to the core that raised it
      showEnded: async (promptId, reason) => this.relayedPreviews.ended(promptId, reason) ?? this.requireLocalClient().themesShowEnded(promptId, reason),
      // a remote chat's shot is that host's core's to hear of, any other this computer's
      screenshotGone: async (shotId) => {
        const authority = this.relayedConsents.shotGone(shotId);
        return authority !== undefined ? tellShotGone(this.relayedShots, authority, shotId) : this.requireLocalClient().themesScreenshotGone(shotId);
      },
    },
    setPreview: (preview) => setThemePreview(preview),
    cardTheme: (stageId, theme) => setCardTheme('local', stageId, theme),
    projectCharacter: (key) => projectCharacter(key),
    editorTakenOver: () => this.themeDock?.previewTakenOver(),
    editorRefused: (reason) => this.themeDock?.previewRefused(reason),
    shownKind: () => currentBaseShown().kind,
    renderAppearance: (theme, kind) => renderAppearance(theme, kind, this.windowLayout.sidebar()),
    shownState: () => {
      const shown = currentShown();
      return { kind: shown.kind, themeId: shown.themeId, decidedBy: shown.decidedBy };
    },
    setHeldLook: (next) => setHeldLook(next),
    heldLookSettled: () => heldLookSettled(),
    currentArrangement: () => arrangementOf(this.windowLayout.sidebar()),
    applyArrangement: (arrangement, density) => this.applyCheckedArrangement(arrangement, density),
    shellChanged: () => this.shellStateChanged(),
    countdownEnded: () => this.keepCountdownEnded(),
    ...(this.keepChangesTimers ? { timers: this.keepChangesTimers } : {}),
    ...(this.screenshotNoticeTimers ? { noticeTimers: this.screenshotNoticeTimers, noticeRaised: (notice: ScreenshotNoticeState) => this.raisedScreenshotNotices.push(notice) } : {}),
    log: (line) => log(line),
  });
  // the user's theme commands: the menu's, the palette's and Settings › Appearance's (main/theme-commands.ts)
  private readonly themeCommands = new ThemeCommands({
    client: () => (this.core.current()?.isReady() ? this.client() : undefined),
    settings: {
      get: (key) => this.requirePlatform().settings.get(key),
      update: (key, value, target) => this.requirePlatform().settings.update(key, value, target),
    },
    shown: () => currentBaseShown(),
    decided: () => decidedShown(),
    shownKind: () => currentThemeKind(),
    preferred: (kind) => preferredThemeId(this.requirePlatform().settings.get<unknown>(kind === 'dark' ? THEMES_DARK_SETTING : THEMES_LIGHT_SETTING)),
    now: () => themeNow(),
    entry: (themeId) => this.themeLibrary?.entry(themeId),
    selectedProject: () => this.selectedProjectKey,
    safeStart: () => {
      setSafeStart('reset');
      this.shellStateChanged();
    },
    arrangement: () => arrangementOf(this.windowLayout.sidebar()),
    applyArrangement: (arrangement, density) => this.applyArrangement(arrangement, density),
    openEditor: async (themeId) => {
      this.overlaySettings?.close();
      return (await this.themeDock?.open(themeId)) === true;
    },
    revealThemeFile: (themeId) => this.requirePlatform().shell.revealPath(themeFilePath(THEMES_DIR, themeId)),
    openProjectLook: (projectKey) => {
      this.openProjectLook(projectKey).then((result) => {
        if (result.kind === 'failed') void this.notificationCenter.notice('warning', result.reason, []);
      }, this.themeCommands.failed('Project Look'));
    },
    notice: (severity, message, actions) => this.notificationCenter.notice(severity, message, actions),
    t: (message, ...args) => this.requireLocalization().t(message, ...args),
    log: (line) => log(line),
  });
  private readonly taskbar = new TaskbarCounter({
    platform: process.platform,
    window: () => this.window,
    badge: (label) => this.taskbarBadges.badge(label),
    setBadgeCount: (count) => app.setBadgeCount(count),
    describe: (count) => {
      const { t } = this.requireLocalization();
      return count === 1 ? t('1 new notification') : t('{0} new notifications', String(count));
    },
    log: (line) => log(line),
  });
  // a remote chat's voice, recorded, transcribed and spoken by this computer's core, and its user-setting writes, which land here
  private readonly foreignViews = new ForeignViewRelay({
    chatView: (viewId) => {
      const view = this.views?.panel(viewId);
      return view && view.kind === 'chat' && !view.isDisposed && this.views?.chats().includes(view) ? view : undefined;
    },
    attached: (authority) => this.remoteCores.get(authority)?.host.current()?.isReady() === true,
    connectionFeatures: (authority) => this.authorities?.connection(authority)?.features,
    hostName: (authority) => this.hostName(authority),
    local: {
      attachForeign: (authority, viewId) => this.core.run('Remote chat view', (core) => core.client.attachForeign(authority, viewId)),
      detachForeign: (viewId) => this.core.run('Remote chat view', (core) => core.client.detachForeign(viewId)),
      foreignMessage: (viewId, message) => this.core.run('Remote chat view', (core) => core.client.foreignMessage(viewId, message)),
      speak: (viewId, text) => this.core.run('Remote voice', (core) => core.client.speak(viewId, text)),
    },
    log: (line) => log(line),
  });
  private userRelays: UserRelays | undefined;
  private openUrl: OpenUrl | undefined;
  private cliRequests: CliRequests | undefined;
  // settles once the launch's tabs and selection are restored, when a command-line request may open its files
  private markWindowReady: () => void = () => undefined;
  private readonly windowReady = new Promise<void>((resolve) => { this.markWindowReady = resolve; });
  // Built before the first command line is read; its deps read the window, core and localization at each call.
  private readonly themeSharing: ThemeSharing = new ThemeSharing({
    core: () => this.client(),
    openInstallCard: () => this.openInstallCard(),
    pickImportFile: () => this.pickThemeImportFile(),
    pickExportPath: (fileName) => this.pickThemeExportPath(fileName),
    notify: (message) => {
      void this.notifications.warn(message);
    },
    t: (message, ...args) => this.requireLocalization().t(message, ...args),
    render: (text) => this.requireLocalization().render(text),
    log: (line) => log(line),
    storeChanged: () => this.overlaySettings?.themesChanged(),
  });
  private readonly notificationCenter: NotificationCenter = new NotificationCenter({
    render: (text) => this.requireLocalization().render(text),
    doNotDisturb: () => this.state.global.get<boolean>(DO_NOT_DISTURB_KEY, false) === true,
    setDoNotDisturb: (on) => this.state.global.update(DO_NOT_DISTURB_KEY, on),
    popupsEnabled: () => this.platform?.settings.get<boolean>(NOTIFICATIONS_SETTING, true) !== false,
    windowFocused: () => this.window?.isFocused() ?? false,
    chatSelected: (corePanelId) => {
      const selected = this.views?.selected();
      return selected !== undefined && selected === this.panelOfCore(corePanelId);
    },
    viewedChat: () => this.viewedChat(),
    flash: (on) => this.flash('notifications', on),
    chatHeld: (corePanelId) => this.panelOfCore(corePanelId) !== undefined,
    describeChat: (corePanelId) => this.describeChat(corePanelId),
    // Only while the main window exists, so the popup window never keeps the app running; from its closed event on it reports destroyed.
    popups: () => (this.window && !this.window.isDestroyed() ? this.notifier.sink() : undefined),
    chime: (tone) => {
      if (this.platform?.settings.get<boolean>(NOTIFICATION_SOUND_SETTING, true) !== false) this.notifier.chime(tone);
    },
    usageWarningShown: (crossing) => this.usageWarnings.shown(crossing),
    recordUsageWarning: (crossing) => {
      void this.usageWarnings.record(crossing);
    },
    run: (action) => {
      runEntryAction(action, this.entryActionDeps).catch(this.report('A notification action'));
    },
    changed: () => this.notificationsChanged(),
    copyText: (text) => clipboard.writeText(text),
    log: (line) => log(line),
  });
  private readonly notifications = createDesktopNotificationService({
    notice: (severity, message, actions) => this.notificationCenter.notice(severity, message, actions),
    ask: this.ask,
    t: (message) => this.requireLocalization().t(message),
    log: (line) => log(line),
    windowFocused: () => this.window?.isFocused() ?? false,
  });
  private readonly core = new CoreHost<DesktopCore>({
    start: () => this.startCoreServices(),
    openTabs: (afterRestart) => this.openInitialChats(afterRestart),
    retainTabStates: (retain) => {
      if (retain) this.heldPrompts.keep();
      this.views?.retainStatesOnClose(retain);
    },
    log: (line) => log(line),
    drainTimeoutMs: CLOSE_TIMEOUT_MS,
    haltedChanged: () => this.engineHaltChanged(),
  });
  // the error notice a halt raised, offering Restart until the engine runs again
  private haltNotice: StickyNotice | undefined;
  private localization: DesktopLocalizationService | undefined;
  private window: BrowserWindow | undefined;
  private views: PanelViews | undefined;
  private browserTabs: BrowserTabs | undefined;
  // the window's design preview tabs, and the editor's page tabs: its browser pages, then its design previews
  private designPreviews: DesignPreviews | undefined;
  // the editor pane's HTML preview tabs' views; outlives a window, whose close drops the views and keeps the tabs
  private htmlPreviews: HtmlPreviews | undefined;
  private pageTabs: BrowserTabSource | undefined;
  // main's Open in browser server and the design-preview session, one each per run
  private designServer: DesignServer | undefined;
  private designSessionReady: Promise<void> | undefined;
  private designRunner: DesignRunner | undefined;
  private designRenderer: DesignRendererHost | undefined;
  private shell: ShellHost | undefined;
  private overlay: OverlayHost | undefined;
  private overlaySettings: OverlaySettings | undefined;
  // the theme editor docked at the window's right edge; one per window, its view made when it first opens
  private themeDock: ThemeEditorDock | undefined;
  // renderer crashes under a custom look; two within a minute switch this run to safe start
  private readonly themeCrashLoop = new ThemeCrashLoop();
  // the theme files main paints from, read and validated again here (docs/invariants.md "Desktop themes")
  private themeLibrary: ThemeLibrary | undefined;
  // this computer's colors, which only main reads; its theme reaches the window through the library and core as a mirror
  private readonly systemColors = new SystemColorSource({
    platform: process.platform,
    systemPreferences,
    nativeTheme,
    log: (line) => log(line),
    ...(process.platform === 'linux'
      ? { desktop: new LinuxDesktopColors({ env: process.env, home: os.homedir(), watch: (base, glob) => this.requirePlatform().fileWatchers.watch(base, glob), log: (line) => log(line) }) }
      : {}),
  });
  private quickOpenPicker: QuickOpenPicker | undefined;
  private readonly backups = new BackupStore(this.userDataDir, (line) => log(line));
  // Files' trash and permanent delete; the e2e hooks replace them to fail on demand.
  private trashEntry = (absolutePath: string): Promise<void> => electronShell.trashItem(absolutePath);
  private removeEntry = (absolutePath: string): Promise<void> => fs.promises.rm(absolutePath, { recursive: true });
  // Runs as a quit's store flush begins; the e2e hooks hold it open.
  private beforeStoreFlush = (): Promise<void> => Promise.resolve();
  private readonly quitJoins = createQuitJoins();
  // Runs as a core dispose begins; the e2e hooks hold it open.
  private beforeCoreDispose = (): Promise<void> => Promise.resolve();
  // Runs as each restore recorded in chatRestores begins; the e2e hooks hold it open or fail it.
  private beforeChatRestore = (): Promise<void> => Promise.resolve();
  // Runs as each Graph history request begins; the e2e hooks hold it open.
  private beforeHistory = (): Promise<void> => Promise.resolve();
  // Runs as the settings modal looks for the chat a tab attaches to; the e2e hooks hold it open or fail it.
  private beforeSettingsTarget = (): Promise<void> => Promise.resolve();
  // The browser page restores main asked core for, while the e2e hooks count them.
  private e2ePageRestores: { count: number } | undefined;
  // Settles once the launch reopened its chats, restores and page restores included, or found it should not.
  private launchTabs: Promise<void> = Promise.resolve();
  // Settles once core finished restoring or setting up a chat, whether core registered the chat or not; every chat has one.
  private readonly chatRestores = new WeakMap<DesktopPanel, Promise<void>>();
  private fileTree: FileTree | undefined;
  private transferGestures: TransferGestures | undefined;
  private fileTransfers: FileTransferService | undefined;
  // the window's Files clipboard: Copy and Cut in Files
  private readonly filesClipboard = new FilesClipboard((change) => this.shell?.filesClipboardChanged(change));
  private documents: DocumentService | undefined;
  private quickOpenIndex: QuickOpenIndex | undefined;
  private search: SearchHost | undefined;
  private scm: ScmHost | undefined;
  // core's ScmService as ScmHost reads and calls it; one per app run, each core attaches
  private scmClient: ScmClient | undefined;
  // the overlay's credential prompts core's askpass server asks for
  private askCredential: AskCredential | undefined;
  // Git hosting accounts of projects: the shell's and overlay's forge channels and the Choose account dialog (main/forge/forge-host.ts)
  private forgeHost: ForgeHost | undefined;
  // CI job logs in editor tabs (main/forge/job-log-tabs.ts)
  private jobLogTabs: JobLogTabs | undefined;
  // the git probeGit found at startup; core's source control spawns its absolute path
  private gitProbe: GitProbe = { available: false, reason: '' };
  // the e2e hooks' stand-in for the commit-message model (DAMOCLES_E2E_HOOKS, unpackaged only)
  private palette: CommandPalette | undefined;
  private editorPane: EditorPane | undefined;
  private formatter: FormatService | undefined;
  private workspaces: Workspaces | undefined;
  // the spellings of the local roots' folders, kept from startEditor on by worktreesChanged
  private readonly rootSpellings = new RootSpellings({ os: process.platform, realpath: (folder) => this.requireWorkspaces().local.files.realpath(folder), log: (line) => log(line) });
  private terminals: TerminalService | undefined;
  private readonly devcontainerConfigs = new DevcontainerConfigs({ read: (key) => this.devcontainerConfig(key), changed: () => this.shellStateChanged(), log: (line) => log(line) });
  private readonly folderIdentities = new FolderIdentityStore({ file: FOLDER_IDENTITIES_PATH, log: (line) => log(line) });
  // a POSIX project's volume is the mount point core recorded for it while it was there
  private readonly presenceProbe = createFolderPresenceProbe({ recordedMount: (folder) => this.folderIdentities.mountOf(folder) });
  private readonly presences = new ProjectPresences({
    presence: ({ fsPath }) => this.presenceProbe.presence(fsPath),
    changed: (key, presence, previous) => this.presenceChanged(key, presence, previous),
    // core may have found the folder absent at a moment this check did not see
    present: (key) => this.scmClient?.folderChecked(key, 'present'),
  });
  // a remote project's folder as its host's workspace finds it while connected; a host that is not connected leaves none missing
  private readonly remotePresences = new ProjectPresences({
    presence: async ({ key, fsPath }) => {
      const workspace = this.authorities?.connectedWorkspace(authorityKeyOfProject(key));
      if (!workspace) return 'present';
      return folderPresenceOf(await remotePathPresence((signal) => workspace.files.isDirectory(fsPath, signal)));
    },
    changed: (key, presence, previous) => this.presenceChanged(key, presence, previous),
    // core may have found the folder absent at a moment this check did not see
    present: (key) => this.scmClient?.folderChecked(key, 'present'),
  });
  // saved chats of a local project whose folder was not there when its chats would have opened, by panel id, with that
  // project; their panels.json entries stay, and they open once the folder is back
  private readonly skippedChats = new Map<string, { readonly saved: PersistedChat; readonly projectKey: string }>();
  private readonly selectionTurns = new SelectionTurns();
  // by destination key, the project a finished move left, local or remote, until its host part changed the list: panels.json
  // or remote-state.json may name the destination already, and its chats belong to the listed project meanwhile
  private readonly movedProjects = new Map<string, string>();
  private readonly terminalLinks = new TerminalLinks((project, relativePath) => this.requireWorkspaces().forProject(project.key).terminals.linkKind(project, relativePath));
  private terminalProfiles: TerminalProfileCatalog | undefined;
  // settles once the shells were detected and the user's profiles validated, after which the window restores its terminals
  private profilesDetected: Promise<void> = Promise.resolve();
  // profilesDetected has settled, so an empty profile list means no shell was found
  private profilesReady = false;
  // the New Terminal pick on screen, whose step 2 terminalPickProfiles serves
  private terminalPick: TerminalPickSession | undefined;
  // settles once the window restored the window layout's terminals
  private terminalsRestored: Promise<void> = Promise.resolve();
  // damocles.desktop.language as read at launch; a change applies after a restart (D23)
  private languageSetting: DesktopLanguageSetting = 'system';
  // damocles.desktop.restoreLayout as read at launch
  private restoreAtLaunch = true;
  private tray: AppTray | undefined;
  private platform: DesktopPlatform | undefined;
  // main's own process launcher pool (search, Quick Open, terminal profiles, the login shell and git probes)
  private launcher: Launcher | undefined;
  // main's walk host, whose processes Quick Open and Search of this computer's projects walk on
  private walks: WalkHost | undefined;
  // what each Damocles Core is forked and connected with
  private coreDeps: CoreConnectionDeps | undefined;
  // the times (performance.now) of core's crashes the restart policy counts (restartDecision)
  private coreCrashes: readonly number[] = [];
  // the times of the reloads core asked for, which the same policy bounds
  private coreReloads: readonly number[] = [];
  // the cores that ended in this app run without releasing their session leases (a crash, or a kill after core.shutdown
  // failed or timed out) and when main saw each end; the next core takes those leases over at once
  private readonly endedCores: { pid: number; endedAt: number }[] = [];
  // a core was started earlier in this app run
  private coreStarted = false;
  // the open window's bounds tracker, which a placement main makes records what it applied in
  private windowBounds: WindowBoundsTracker | undefined;
  private updates: UpdateService | undefined;
  private releaseNotes: ReleaseNotesSource | undefined;
  private readonly disposables: Disposable[] = [];
  // Settles once the window is gone and the requests its shell and overlay pages made were answered.
  private windowClosed: Promise<void> = Promise.resolve();
  // The selected project; the selected chat belongs to it once one is selected. Its own look shows once shellStateChanged
  // tells the theme of it, which every change of the selection ends in.
  private selectedProjectKey: string | undefined;
  // ShellState.layoutRevision
  private layoutRevision = 0;
  // the chat last viewed in each project, which selecting the project selects again
  private readonly lastChats = new LastChats({
    writeLocal: (entries) => this.states.setLastChats(entries),
    writeRemote: (authority, entries) => this.remoteState?.setLastChats(authority, entries).catch(this.report('Saving the last chats')),
  });
  // The project a chat was opened in, until core reports the chat's folder.
  private readonly openedInProject = new WeakMap<DesktopPanel, string>();
  private readonly lastViewed = new WeakMap<DesktopPanel, number>();
  // A design chat core opened beside its parent chat: the parent's view, which the chat list nests it under until its row lists one.
  private readonly designParents = new WeakMap<DesktopPanel, DesktopPanel>();
  private viewCount = 0;
  // Latest activity by core panel id; pruned when retention runs.
  private readonly activity = new Map<string, ChatActivity>();
  // the chats' review tabs and draft comments (D60)
  private readonly chatReviews = new ChatReviewHost({
    session: (key) => {
      const { authority, corePanelId } = parseChatKey(key);
      return this.clientFor(authority)?.reviewSession(corePanelId);
    },
    sessionId: (key) => {
      const { authority, corePanelId } = parseChatKey(key);
      return this.clientFor(authority)?.chat(corePanelId)?.sessionId;
    },
    title: async (panelId) => {
      const panel = this.panelOfCore(panelId);
      return panel ? this.readTitleOf(panel) : '';
    },
    editorPane: () => this.requireEditorPane(),
    warn: (message) => void this.notifications.warn(message),
    t: (message, ...args) => this.requirePlatform().localization.t(message, ...args),
    menuChanged: () => this.refreshMenuState(),
    log: (line) => log(line),
  });
  // Each project's stored sessions from its last catalog read, for titles outside a list request.
  private readonly catalogRows = new Map<string, readonly StoredSession[]>();
  // by authority, then session id: each session's title as last read, which outlives the chat's view (a host connecting)
  private readonly knownTitles = new Map<string, Map<string, string>>();
  // chats last seen with no session, shown as New chat until a read titles the session they start
  private readonly untitledChats = new WeakSet<DesktopPanel>();
  // by host id, what its chat pages were last sent: their banner's attention and update
  private readonly sentHostAttention = new Map<string, string>();
  // the hostNames this computer's chat pages last heard, so an unrelated host store change sends nothing
  private sentHostNames = '';
  private readonly chatWork = new ChatWorkQueue();
  // retention's unloads core has not answered: their chats are not shown meanwhile
  private readonly unloads = new ChatUnloads<DesktopPanel>();
  // Worktree chats (slice 12a): core's registry as its worktrees mirror shows it, kept across a core restart.
  private readonly worktreeRecords = new WorktreeRecords(localRecord(path.join(DAMOCLES_HOME_DIR, 'worktrees')), (line) => log(line));
  // core's worktree git and registry work, on the running core
  private readonly worktreeEngine: WorktreeEngine = worktreeEngine((method, args) => this.core.run(`Worktree ${method}`, (core) => core.client.worktreeCall(method, args)));
  private readonly roots = new WorktreeRoots({ projects: () => this.workspaceProjects(), registry: (authority) => this.worktreeRegistry(authority), osOf: (projectKey) => this.projectOs(projectKey) });
  // the loopback servers of chats' project and design roots and of Open in Browser (docs/invariants.md "Ports and the remote browser")
  private readonly servedRoots = new ServedRoots({
    projectOfView: (authority, viewId) => this.servedProjectOf(authority, viewId),
    chatView: (authority, viewId) => this.chatViewOf(authority, viewId) !== undefined,
    projects: () => this.roots.all(),
    files: (rootKey) => this.requireWorkspaces().forProject(rootKey).files,
    isTrusted: (project) => this.isProjectTrusted(project),
    // core's designFolderOf, which a restored page's file:// address must resolve against
    localDesignFolder: (designId) => path.join(DAMOCLES_DESIGNS_DIR, designId),
    designRead: (authority, designId, relPath) => this.designRead({ authority, designId }, relPath),
    refusalText: () => this.requireLocalization().t('Open this preview from Damocles.'),
    log: (line) => log(line),
  });
  private worktrees: WorktreeController | undefined;
  // each remote host's registry and controller: its worktrees live in its core's registry and git, kept across a reattach
  private readonly remoteWorktreeRecords = new Map<string, WorktreeRecords>();
  private readonly remoteWorktrees = new Map<string, WorktreeController>();
  private askWorktreeDialog: AskWorktreeDialog | undefined;
  // core's last worktree state by core panel id
  private readonly worktreeStates = new Map<string, WorktreeEvent>();
  private readonly shownFolders = new ShownFolderState({
    roots: this.roots,
    selectedChat: (projectKey) => this.selectedChatPlace(projectKey),
    finish: (root) => this.finishStateOf(root.worktree!),
    newChatIn: (record) => this.newChatInTarget(record),
  });
  // the roots terminals, the file tree, Quick Open and the formatter hosts last followed
  private readonly rootSet = new RootSet();
  // the root keys of the editor tabs, from the editor's last state
  private editorRootKeys: ReadonlySet<string> = new Set();
  private readonly heldPrompts = new HeldPrompts({
    chats: () => (this.views?.chats() ?? []).filter((chat) => chat.authority === 'local').map((chat) => ({ panelId: chat.panelId, corePanelId: this.corePanelIdOf(chat) })),
    held: (corePanelId) => this.core.current()?.client.chat(corePanelId)?.heldPrompt as readonly UserContentBlock[] | undefined,
    store: { setHeldPrompt: (panelId, held) => this.states.setHeldPrompt(panelId, held) },
  });
  private readonly keptPermissions = new KeptPermissions();
  // worktree roots source control keeps open while a flow needs their repository (Push branch)
  private readonly pinnedScmRoots = new Set<string>();
  // chats a worktree delete unloads, whose close selects no other chat
  private readonly closingForWorktree = new WeakSet<DesktopPanel>();
  // local projects a Remove Project is removing: a chat it closes selects nothing until the removal settles the selection
  private readonly removingProjects = new Set<string>();
  // Locate: by relocation id, what this run prepared for the moves it started; by project key, the last refusal its row shows
  private readonly locatePrepared = new Map<string, LocatePrepared>();
  private readonly locateRefusals = new Map<string, Coded>();
  // by project key, the new folder a Locate's relocate request names until that Locate ends
  private readonly locateTargets = new Map<string, string>();
  // by authority: its core's relocations mirror, this run's Locate targets, what it prepared or trustPending changed
  private readonly relocationTargetsChanged = new Emitter<[authority: string]>('relocation-targets', (line) => log(line));
  // by authority: the folders a remote Add Project or Locate asked trust for, until that flow ends
  private readonly trustPending = new TrustPending((authority) => this.relocationTargetsChanged.fire(authority));
  // by project key, the Locates under way; and the requests whose relocate failed without an answer
  private readonly locating = new Set<string>();
  private readonly interruptedLocates = new InterruptedLocates();
  // the repair notices shown in this run, by relocation, outcome and the worktrees it left unlinked
  private readonly repairNotices = new Set<string>();
  // by relocation id, the project's name before the move
  private readonly relocationNames = new Map<string, string>();
  private readonly relocatedProjects = new RelocatedProjects({
    keyOf: folderKey,
    listed: (key) => (this.listedFolder(key) ? { name: this.localProjectName(key) } : undefined),
    absent: (key) => this.presences.absent(key),
    applied: (id) => this.projects.relocated(id),
    offerOpen: async (view, name) => {
      const { t } = this.requireLocalization();
      return (await this.notificationCenter.notice('info', t('Chats of {0} moved to {1}.', visibleText(name), visibleText(view.to)), [t('Open')])) === 0;
    },
    askClose: (key) => this.askLocateClose(key),
    isTrusted: (fsPath) => this.trust.isTrusted(fsPath),
    requestTrust: (fsPath) => this.trust.requestTrust(fsPath),
    savedTabs: (key) => this.windowLayout.editor().tabs.flatMap((tab) => ('file' in tab && tab.kind !== 'searchEditor' && tab.kind !== 'htmlPreview' && tab.file.projectKey === key ? [tab.file] : [])),
    relocateStores: async (from, to) => {
      this.movedProjects.set(to.key, from.key);
      this.states.relocate(from.key, to.key);
      for (const [panelId, skipped] of [...this.skippedChats]) {
        if (skipped.projectKey === from.key) this.skippedChats.set(panelId, { saved: this.states.get(panelId) ?? skipped.saved, projectKey: to.key });
      }
      this.lastChats.relocate(from.key, to.key);
      this.windowLayout.relocateProject(from, to, path);
    },
    relocateWorktreeStores: (worktree, fromKey, toKey) => {
      const from = { key: rootKey({ projectKey: fromKey, worktreeId: worktree.worktreeId }), fsPath: worktree.from };
      const to = { key: rootKey({ projectKey: toKey, worktreeId: worktree.worktreeId }), fsPath: worktree.to };
      this.windowLayout.relocateProject(from, to, path);
    },
    revokeTrust: (fsPath) => this.trust.revoke(fsPath),
    applyHostState: (view) => this.core.run('Locate Project', (core) => core.client.applyRelocationHostState(view.id)),
    relocateList: async (from, to, id) => {
      await this.projects.relocate(from.fsPath, to.fsPath, id);
      // before the list change's shell state goes out (setImmediate), which would name a project main no longer lists
      if (this.selectedProjectKey === from.key) this.selectedProjectKey = to.key;
      this.movedProjects.delete(to.key);
    },
    // the sidebar order and the WSL notice flag, which remote-hosts.json keeps
    relocateOrder: async (from, to) => {
      await this.hostStore?.relocateProject(from.key, to.key);
    },
    relocateRoot: (fromRootKey, toRootKey) => this.requireEditorPane().relocateRoot(fromRootKey, toRootKey),
    reopenTabs: (files) => this.reopenRelocatedTabs(files),
    closeOldRoot: (key, answers) => {
      if (!this.requireEditorPane().closeRoot(key, answers)) log(`[projects] the moved project's tabs stay open: one was edited after its question`);
    },
    reopenChats: (toKey) => this.reopenSkippedChats(toKey),
    select: (key) => this.selectProject(key, false),
    announce: (message) => { void this.notificationCenter.notice('info', message, []); },
    describe: (failure, project) => relocationText(failure, project, (message, ...args) => this.requireLocalization().t(message, ...args)),
    report: (action, err) => this.report(action)(err),
    t: (message, ...args) => this.requireLocalization().t(message, ...args),
  });
  // by remote authority, the host part of its core's relocations on this computer, built for the host's OS and id it names
  private readonly remoteRelocated = new Map<string, { readonly os: NodeJS.Platform; readonly hostId: string | undefined; readonly relocated: RelocatedProjects }>();
  // by authority, the ids its core's relocations mirror held last; what leaves it is forgotten
  private readonly mirroredRelocations = new Map<string, ReadonlySet<string>>();
  // by remote authority, its project paths when its registry last judged its records
  private readonly remoteRecordPaths = new Map<string, string>();
  // remote chats of a project whose folder its host does not find, by panel token: not reopened, their records kept in
  // remote-state.json until the folder is back or the project moved
  private readonly skippedRemoteChats = new Map<string, RemoteChatRecord & { readonly projectKey: string }>();
  // new chats that show once core holds their worktree opt-in
  private readonly openingInWorktree = new WeakSet<DesktopPanel>();
  private retentionScheduled = false;
  private readonly chatFoldersChanged = new Emitter<[]>('chat-folders', (line) => log(line));
  private shellFocusedPart: ShellFocusPart | null = null;
  // The terminal whose xterm input has keyboard focus, panel or editor, as the shell reports; it routes Edit › Paste and the keys.
  private terminalInputFocused: string | null = null;
  // A context-menu click or key in the shell page, which a shell menu with clipboard items takes.
  private readonly shellMenuGrant = new GestureGrant<true>();
  // a host's watcher that ran out of inotify watches for a project: its notification and its card's notice
  private readonly watchLimits = createWatchLimits({
    projects: (authorityKey) => this.remoteProjects().filter((project) => project.authorityKey === authorityKey),
    notify: (authorityKey, project) => {
      const { t } = this.requireLocalization();
      const message = t('{0} cannot watch every folder of {1} for changes: its inotify watch limit is used up. Damocles changes nothing; to raise the limit, run on {0}: {2}', this.hostName(authorityKey), project, WATCH_LIMIT_COMMAND);
      this.notificationCenter.notice('warning', message, [], this.notificationHost(authorityKey)).catch(this.report('Showing the inotify watch limit'));
    },
    changed: (authorityKey) => {
      const hostId = this.savedHostIdOf(authorityKey);
      if (hostId !== undefined) this.remoteHosts?.hostChanged(hostId);
    },
    log: (line) => log(line),
  });
  // another machine running Damocles in a host's home: its notification and its card's notice
  private readonly sharedHomes = createSharedHomes({
    notify: (authorityKey, hosts) => this.notifySharedHome(authorityKey, hosts),
    changed: (authorityKey) => {
      const hostId = this.savedHostIdOf(authorityKey);
      if (hostId !== undefined) this.remoteHosts?.hostChanged(hostId);
    },
    log: (line) => log(line),
  });
  // each authority's connection whose watch limit reports main hears
  private readonly watchLimitConnections = new Map<string, { readonly connection: RemoteConnection; readonly subscription: Disposable }>();

  private readonly terminalPaste = new TerminalPasteGate({
    commandTarget: () => this.terminals?.commandTarget() ?? null,
    terminalFocused: () => this.focusedPart() === (this.terminals?.target()?.placement === 'editor' ? 'editor' : 'terminal'),
    read: (source) => {
      const board = source === 'selection' ? clipboard.selection : clipboard;
      if (!board) throw new Error('This platform has no selection clipboard');
      return board.readText();
    },
    paste: (text, request) => {
      const platform = this.requirePlatform();
      const terminals = this.requireTerminals();
      return pasteText(text, request.bracketedPasteMode, {
        setting: terminalSettings(platform.settings).multiLinePasteWarning,
        ask: this.ask,
        t: (message, ...args) => platform.localization.t(message, ...args),
        write: (data) => terminals.write(request.id, data),
      });
    },
    log: (line) => log(line),
  });
  // The part F6 moved keyboard focus from into the desktop popups, until focus is anywhere else or the popup window loses it.
  private toastFocusOrigin: FocusPart | undefined;
  private readonly keepFocus = new KeepFocus<FocusPart>();
  // the part keyboard focus came from into the screenshot notice, which it returns to as the notice closes
  private readonly noticeFocus = new KeepFocus<FocusPart>();
  // the last part other than the desktop popups that held keyboard focus
  private lastFocusedPart: FocusPart | undefined;
  // What the main window focuses once it gains focus (a part left from the popups, or an overlay popup opened while it was
  // unfocused), until a later focusOn places focus, that popup closes or the window does.
  private focusOnActivation: FocusPart | 'overlay' | undefined;
  private readonly activationFocus = new ActivationFocus<WebContents>((contents) => contents === this.window?.webContents);
  // Why the taskbar button flashes: an entry waiting on the user, or an overlay popup waiting for the window to activate.
  private readonly flashReasons = new Set<'notifications' | 'overlay'>();

  // ~/.damocles was there when this launch started, read before anything of it could create the folder
  private readonly damoclesHomeExisted: boolean;

  // The stores log what they skip while reading their files, so they are read only once the log sink is installed.
  constructor(damoclesHomeExisted: boolean) {
    this.damoclesHomeExisted = damoclesHomeExisted;
    installLogSink(this.logSink);
    logUncaughtErrors(process, 'main', (line) => log(line));
    this.states = new PanelStateStore(this.userDataDir, (line) => log(line));
    this.windowLayout = new WindowLayoutStore(this.userDataDir, (line) => log(line));
    this.projects = new ProjectList(this.userDataDir, (line) => log(line));
    this.state = createDesktopKeyValueState(this.userDataDir, (line) => log(line));
    this.trust = new TrustStore(this.userDataDir, this.ask, (message, ...args) => this.requireLocalization().t(message, ...args), (line) => log(line));
    this.usageWarnings = new UsageWarningStore(this.userDataDir, (line) => log(line));
    this.themeState = new ThemeState(this.userDataDir);
  }

  private startStallMonitor(bootLog: (line: string) => void): StallMonitor | undefined {
    try {
      const monitor = new StallMonitor({ process: 'main', dir: path.join(this.logsDir, 'stalls'), log: bootLog, startProfile: processProfiler(process.platform) });
      this.disposables.push(monitor);
      return monitor;
    } catch (err) {
      bootLog(`[stall] the main process stall monitor could not start: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async start(): Promise<void> {
    const bootLog = (line: string): void => log(line);
    const stalls = this.startStallMonitor(bootLog);
    // Chromium fixes its UI locale at launch, so the switch goes in before the app is ready.
    this.languageSetting = readLanguageSetting(path.join(DAMOCLES_HOME_DIR, 'settings.json'), bootLog);
    if (this.languageSetting !== 'system') app.commandLine.appendSwitch('lang', this.languageSetting);
    // dist/cli.js starts a second instance with its request, which this one handles
    // a damocles:// link arrives the same way on Windows and Linux, the OS starting the app with the link as an argument
    app.on('second-instance', (_event, argv) => {
      this.showWindow();
      this.takeCommandLine(argv);
      this.themeSharing.takeArgv(argv);
    });
    // macOS hands a link to the running app, and to one it launches before ready, so this listens from the start
    app.on('open-url', (event, url) => {
      event.preventDefault();
      this.themeSharing.takeOpenUrl(url);
    });
    // a first launch's own request, from dist/cli.js; its wait marker is claimed now and the request handled once the window is ready
    this.takeCommandLine(process.argv);
    // a link that launched the app waits in the queue until the window and core are ready
    this.themeSharing.takeArgv(process.argv);
    this.disposables.push({ dispose: () => this.themeSharing.dispose() });
    app.on('web-contents-created', (_event, contents) => {
      // a remote chat page's links, and a remote project's HTML preview's, go through the link checks, as a click in a remote terminal does
      hardenWebContents(contents, (url) => {
        const authority = this.views?.remoteChatAuthority(contents) ?? this.htmlPreviews?.remoteAuthority(contents);
        return authority === undefined ? this.requirePlatform().shell.openExternal(url) : this.requireOpenUrl().userClick(authority, url);
      }, bootLog);
      // Menu items enable by the focused part, and only main sees focus move between views.
      contents.on('focus', () => {
        if (!this.notifier.owns(contents)) this.toastFocusOrigin = undefined;
        this.views?.focused(contents);
        if (contents === this.window?.webContents || this.windowView(contents)) this.activationFocus.focused(contents);
        this.partFocused(this.focusedPart());
        this.refreshMenuState();
      });
      contents.on('blur', () => this.refreshMenuState());
      // The user's first key or click drops a launch's focus and decides an activation's; page script's synthetic events never reach these.
      contents.on('before-input-event', (_event, input) => {
        if (input.type !== 'keyDown') return;
        this.views?.userInput();
        this.activationFocus.userInput();
      });
      contents.on('before-mouse-event', (_event, mouse) => {
        if (mouse.type !== 'mouseDown') return;
        this.views?.userInput();
        this.activationFocus.userInput();
      });
    });

    // Before the first process start, the login shell read; its workers share process.env, so they see what the read merges.
    const appPaths = createDesktopAppPaths(layout);
    lockThreadSpawns();
    this.launcher = createLauncherPool({ workerPath: appPaths.workerEntry('processLauncher'), sentinelPath: appPaths.workerEntry('sentinel') });
    installProcessLauncher(this.launcher);
    await mergeLoginShellEnv(processLauncher(), bootLog);
    await app.whenReady();
    await registerThemeLinkScheme();
    // macOS and Linux shut down: the quit is let finish, keeping the remote runs with no question
    const shutdown = (event: Electron.Event): void => {
      event.preventDefault();
      this.quitUnattended('the system shuts down');
    };
    // Electron passes the event its documentation describes, which its typings leave out
    const onShutdown = shutdown as () => void;
    powerMonitor.on('shutdown', onShutdown);
    this.disposables.push({ dispose: () => powerMonitor.removeListener('shutdown', onShutdown) });
    if (stalls) {
      const suspend = (): void => stalls.suspend();
      const resume = (): void => stalls.resume();
      powerMonitor.on('suspend', suspend);
      powerMonitor.on('resume', resume);
      this.disposables.push({ dispose: () => {
        powerMonitor.removeListener('suspend', suspend);
        powerMonitor.removeListener('resume', resume);
      } });
    }
    const problem = runtimeProblem();
    if (problem !== undefined) {
      dialog.showErrorBox('Damocles cannot start', problem);
      app.exit(1);
      return;
    }
    // The Language setting replaces the language the chat webview stored, so the webview follows it too.
    if (this.languageSetting !== 'system' && this.state.global.get<string>(LANGUAGE_PREFERENCE_KEY) !== undefined) {
      await this.state.global.update(LANGUAGE_PREFERENCE_KEY, undefined);
    }
    const localization = createDesktopLocalizationService(resourceRoot, this.preferredLanguage(), bootLog);
    this.localization = localization;
    const git = await probeGit(bootLog, (message, ...args) => localization.t(message, ...args));
    this.gitProbe = git;
    restrictPermissions(session.defaultSession);
    handleAppProtocol(resourceRoot, {
      panel: (panelId) => this.views?.htmlFor(panelId),
      shell: () => shellHtml(currentTheme(), localization.language),
      overlay: () => overlayHtml(currentTheme('root'), localization.language),
      // The overlay bundle, which shows only its toast stack at this path.
      notifier: () => overlayHtml(currentTheme('root'), localization.language),
      // The overlay bundle at its theme editor route: trusted UI whole, so its page palette is the trusted one.
      themeEditor: () => overlayHtml(currentTheme('root'), localization.language),
      forgeAvatar: (key) => {
        const client = this.client();
        return client?.forgeAvatarKnown(key) === true ? this.forgeAvatars.get(key) : Promise.resolve(undefined);
      },
      themeBlob: (sha256) => openThemeBlob(THEMES_DIR, sha256, (sha) => this.namedBlob(sha), (sha) => this.themeLibrary?.packedAsset(sha), this.themeNotices),
      themeCache: (sha256, file) => readThemeThumb(THEMES_DIR, sha256, file, this.themeNotices),
      storeThumb: (sha256) => readStoreThumb(THEMES_DIR, sha256, this.themeNotices),
      themeShot: (id) => this.agentThemes.shot(id),
      ...(E2E_HOOKS ? { themeBlobServed: (sha256: string, status: number, contentRange: string | null) => this.servedThemeBlobs.push({ sha256, status, contentRange }) } : {}),
    });
    // the theme renderer's page loads in a session of its own, which serves only what its running job draws or decodes
    createThemeRenderSession(resourceRoot, {
      themeRender: () => themeRenderHtml(),
      themeBlob: (sha256) => openThemeBlob(THEMES_DIR, sha256, (sha) => this.themeRenderer.currentJobBlob(sha), (sha) => this.themeLibrary?.packedAsset(sha), this.themeNotices),
      themeCache: async (sha256, file) => (this.themeRenderer.currentJobStill(sha256) ? readThemeThumb(THEMES_DIR, sha256, file, this.themeNotices) : undefined),
      ...(E2E_HOOKS ? { themeBlobServed: (sha256: string, status: number, contentRange: string | null) => this.servedThemeBlobs.push({ sha256, status, contentRange }) } : {}),
    });

    [this.hostStore, this.remoteState] = await Promise.all([HostStore.open(this.userDataDir, bootLog), RemoteState.open(this.userDataDir, bootLog)]);
    const heldState = this.remoteState;
    this.offlineQueue = new OfflineQueue({
      stored: heldState.offlineQueue(),
      save: (panelToken, panel) => heldState.setOfflineQueue(panelToken, panel),
      canSave: () => heldState.unreadable() === undefined,
      changed: (panelToken) => this.heldMessagesChanged(panelToken),
      newId: () => randomUUID(),
      report: this.report('Saving the held chat messages'),
    });
    this.remoteTrust = createRemoteTrust({ store: this.hostStore, ask: this.ask, t: (message, ...args) => localization.t(message, ...args), log: bootLog });
    this.projectTrust = createProjectTrust({
      local: this.trust,
      remote: this.remoteTrust,
      remoteTarget: (projectKey) => {
        const project = this.remoteProject(projectKey);
        return project && this.remoteTrustTarget(project);
      },
    });
    this.platform = createDesktopPlatform({
      userDataDir: this.userDataDir,
      layout,
      logSinks: this.logSinks,
      localization,
      state: this.state,
      notifications: this.notifications,
      projects: this.projects,
      trust: this.trust,
      window: () => this.window,
      showChatReview: (panelId, scope) => this.showChatReview(panelId, scope),
      openAppSettings: (section, account, scope, forge) => this.openSettings({
        ...(section !== undefined ? { section } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(forge !== undefined ? { forgeServer: forge.server, ...(forge.account !== undefined ? { forgeAccount: forge.account } : {}) } : {}),
      }, scope),
      toggleTerminal: () => this.toggleTerminal(false),
      terminalToggle: () => this.terminalToggle(),
      locateProjectFolder: (key) => { void this.locateProject(key); },
      chatTabs: this.chatTabs,
      editorPane: () => this.requireEditorPane(),
      chatFolders: {
        folders: () => (this.core.current()?.client.chats() ?? []).flatMap((chat) => chat.settingsFolder ?? []),
        onDidChange: (cb) => this.chatFoldersChanged.add(cb),
      },
      reload: () => this.coreRequestedReload(),
      revealable: (absolutePath) => revealAllowed(absolutePath, {
        os: process.platform,
        roots: this.roots.all(),
        spellings: this.rootSpellings,
        wslDistros: this.requireHostStore().hosts().flatMap((host) => (host.kind === 'wsl' ? [host.distro] : [])),
        resolveOutside: (target) => this.requireWorkspaces().local.files.resolveOutside(target),
        walksBelow: walkingBelow(followsLocalLinksOnly),
      }).catch((err: unknown) => {
        throw withRenderedMessage(err, (text) => localization.render(text));
      }),
      revealRefused: (absolutePath, reason) => void this.notifications.warn(reason === 'name'
        ? localization.t('Damocles does not show {0} in File Explorer, because part of this path would be read differently than it is written, such as \'..\', a stream or a reserved device name.', visibleText(absolutePath))
        : localization.t('Damocles does not show {0} in File Explorer, because it is on a network share or a device outside your projects.', visibleText(absolutePath))),
      log: bootLog,
    });
    installPlatform(this.platform);
    this.userRelays = this.startUserRelays(this.platform, appPaths.resourceRoot);
    const worktrees = this.startWorktrees();
    this.authorities = this.startAuthorities(this.platform);
    this.startRemoteHosts(this.hostStore);
    this.startReconnects();
    this.walks = mainWalkHost(appPaths.workerEntry('walkChild'), (line) => log(line));
    this.workspaces = createWorkspaces(createLocalWorkspace({
      paths: this.platform.paths,
      watchers: this.platform.fileWatchers,
      walks: this.walks,
      trash: (absolutePath) => this.trashEntry(absolutePath),
      remove: (absolutePath) => this.removeEntry(absolutePath),
      zshDotDir: path.join(this.userDataDir, 'shell-integration', 'zsh'),
      homedir: homeDirectory(),
      log: (line) => log(line),
    }), (authorityKey) => this.remoteWorkspace(authorityKey));
    this.startEditor(this.platform, localization);
    // After the editor pane, whose active context core mirrors.
    const worker = (name: Parameters<typeof appPaths.workerEntry>[0]): string => appPaths.workerEntry(name);
    this.coreDeps = {
      platform: this.platform,
      trust: this.trust,
      terminalToggle: () => this.terminalToggle(),
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
      createView: (panelId, create) => this.createCoreView(panelId, create),
      // a remote chat's page belongs to this computer's core, and its tab to the remote chat
      foreignOwner: (viewId) => {
        const chat = this.views?.panel(viewId);
        return chat && chat.kind === 'chat' && chat.authority !== 'local' ? chat : undefined;
      },
      servedFile: (request) => this.servedFile(request),
      clientNetwork: {
        current: () => this.requirePorts().clientNetworks(),
        onDidChange: (listener) => this.requirePorts().onClientNetwork(listener),
      },
      systemTheme: {
        current: () => ({ looks: this.systemColors.looks() }),
        onDidChange: (listener) => this.systemColors.onDidChange(() => listener({ looks: this.systemColors.looks() })),
      },
      divert: (view, message) => this.divertViewMessage(view, message),
      showSession: (sessionId) => this.showSessionOf('local', sessionId),
      openDesignPreview: (corePanelId, designId, relPath) => this.openDesignPreview('local', corePanelId, designId, relPath),
      designRender: this.designRenderFor('local'),
      themes: {
        ...this.agentThemes.services(),
        // core's cancel frees the renderer, which runs one job at a time
        'themes.analyze': ({ sha256, mime, width, height, kind, durationMs }, signal) => this.themeRenderer.analyze(sha256, mime, { width, height }, kind ?? 'image', durationMs, signal),
        'themes.analyzeSprite': ({ sha256, mime, width, height, strip, animated }, signal) => this.themeRenderer.analyzeSprite(sha256, { mime, width, height, ...(strip ? { strip } : {}), animated }, signal),
        'themes.copyName': ({ themeId, name }) => ({ name: themeCopyName(themeId, name, this.requireLocalization()) }),
      },
      git: git.available ? { available: true, path: git.path, version: git.version } : { available: false, reason: git.reason },
      e2eHooks: E2E_HOOKS,
      ...(FORGE_E2E_SERVERS ? { e2eForgeServers: FORGE_E2E_SERVERS } : {}),
      ...(THEME_E2E_DOWNLOADS ? { e2eThemeDownloads: path.resolve(THEME_E2E_DOWNLOADS) } : {}),
      themesOwner: this.themesOwner,
      ...(THEME_E2E_STORE ? { e2eThemeStore: THEME_E2E_STORE } : {}),
      paths: {
        resourceRoot: appPaths.resourceRoot,
        unpackedRoot: appPaths.unpackedRoot,
        workers: {
          compass: worker('compass'),
          usageStats: worker('usageStats'),
          sentinel: worker('sentinel'),
          processLauncher: worker('processLauncher'),
          memoryIntegrity: worker('memoryIntegrity'),
          sessionMetaIndex: worker('sessionMetaIndex'),
          voiceExtract: worker('voiceExtract'),
          walkChild: worker('walkChild'),
          diff: worker('diff'),
        },
        watchWorker: watchWorkerPath(appPaths),
        remoteMirrors: path.join(this.userDataDir, 'remote'),
        forge: path.join(this.userDataDir, 'forge'),
        // core's process.execPath is this same executable
        askpass: askpassPaths(appPaths, process.execPath),
      },
      logs: { dir: this.logsDir, echo: !app.isPackaged },
      language: { current: () => localization.language, onDidChange: (listener) => localization.onDidChangeLanguage(() => listener()) },
      render: (text) => localization.render(text),
      power: {
        onSuspend: (listener) => {
          powerMonitor.on('suspend', listener);
          return { dispose: () => powerMonitor.removeListener('suspend', listener) };
        },
        onResume: (listener) => {
          powerMonitor.on('resume', listener);
          return { dispose: () => powerMonitor.removeListener('resume', listener) };
        },
      },
      ui: {
        showLog: (name, preserveFocus) => this.openLogTab(path.join(this.logsDir, logFileName(name)), preserveFocus),
        trash: (absolutePath) => this.trashEntry(absolutePath),
        ask: (question, signal) => this.ask(question, signal),
        askpass: (prompt, signal) => {
          if (!this.askCredential) throw new Error('Source control used before startup finished');
          return this.askCredential(prompt, signal);
        },
        chooseForgeAccount: (request, signal) => {
          if (!this.forgeHost) throw new Error('Git hosting accounts used before startup finished');
          return this.forgeHost.chooseAccount(request, signal);
        },
        worktrees: worktrees.ui(),
      },
      entry: coreHostEntryPath(appPaths),
      echo: !app.isPackaged,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      readyTimeoutMs: CORE_READY_TIMEOUT_MS,
      log: bootLog,
    };
    this.ports = this.startPorts(this.platform, localization);
    this.agentRelays = new AgentRelays({
      record: (authorityKey) => {
        const hostId = this.hostStore?.hostIdOf(authorityKey);
        return hostId === undefined ? undefined : this.hostStore?.host(hostId);
      },
      connection: (authorityKey) => this.authorities?.heldConnection(authorityKey),
      agentPath: () => localAgentPath(process.env, process.platform),
      connectAgent: (agentPath) => netConnect(agentPath),
      log: (line) => log(line),
    });
    this.terminals = await this.createTerminals(this.platform, localization);
    log(`Damocles desktop starting (version ${this.platform.appInfo.version}, Electron ${process.versions.electron}, userData ${this.userDataDir})`);
    const version = this.platform.appInfo.version;
    // The desktop build copies CHANGELOG.md next to main.js (D56).
    this.releaseNotes = new ReleaseNotesSource(path.join(__dirname, 'CHANGELOG.md'), version, (line) => log(line));
    const updates = new UpdateService({
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      version,
      notifications: this.notifications,
      shell: this.platform.shell,
      state: this.state.global,
      checkAutomatically: () => this.platform?.settings.get<boolean>(UPDATE_CHECK_AUTOMATICALLY_SETTING, true) !== false,
      storeCheck: () => this.core.run('The community store check', (core) => core.client.themesStoreBackgroundCheck()),
      onResume: (listener) => {
        powerMonitor.on('resume', listener);
        return { dispose: () => powerMonitor.removeListener('resume', listener) };
      },
      t: (message, ...args) => localization.t(message, ...args),
      log: bootLog,
      showLog: () => showLog(),
      load: loadAutoUpdater,
      // the update's own quit keeps remote runs with no question (D3)
      quit: () => {
        this.closeRelease.keepRunsWithoutAsking();
        return this.lifecycle.quit();
      },
    });
    this.updates = updates;
    this.disposables.push(updates, updates.onDidChange((snapshot) => this.updateChanged(snapshot)));
    this.disposables.push(this.presenceProbe.onDidAnswerLate((folder) => this.folderAnsweredLate(folder)));
    this.disposables.push(this.presenceProbe.onDidAdmit(() => this.folderChecksAdmitted()));

    // Before the window exists, which takes its background from the shown look.
    if (isSafeThemeLaunch(process.argv)) {
      log('[themes] started with the Damocles theme (safe start)');
      setSafeStart('launch');
    }
    // Before the library's first read and this computer's core, both of which read the preferred looks it may write.
    await seedSystemDefault({
      homeExisted: this.damoclesHomeExisted,
      stateAbsent: this.state.absentAtStart,
      state: this.state.global,
      settings: this.platform.settings,
      log: (line) => log(line),
    });
    const themeLibrary = new ThemeLibrary({ root: THEMES_DIR, resourceRoot, watchers: this.platform.fileWatchers, log: (line) => log(line), notifications: this.themeNotices, system: this.systemColors });
    this.themeLibrary = themeLibrary;
    setWallpaperStatsReader((sha256) => readWallpaperStats(THEMES_DIR, sha256, this.themeNotices));
    setWallpaperFlashReader((sha256) => readWallpaperFlash(THEMES_DIR, sha256, this.themeNotices));
    await this.themeState.load((line) => log(line), this.themeNotices);
    setWallpaperCycle((look) => this.themeState.shownIndex(look, Date.now()));
    this.followPower();
    // without GPU compositing every blurred wallpaper and see-through view would be drawn in software
    const gpuCompositing = (): boolean => app.getGPUFeatureStatus().gpu_compositing.startsWith('enabled');
    setWallpaperEnvironment({ gpuCompositing: gpuCompositing(), reducedTransparency: nativeTheme.prefersReducedTransparency === true });
    const gpuChanged = (): void => setWallpaperEnvironment({ gpuCompositing: gpuCompositing(), reducedTransparency: nativeTheme.prefersReducedTransparency === true });
    app.on('gpu-info-update', gpuChanged);
    this.disposables.push({ dispose: () => app.removeListener('gpu-info-update', gpuChanged) });
    // a capture or a repaint that fails while Chromium restarts its GPU process leaves no other line in the log
    const processGone = (_event: Electron.Event, details: Electron.Details): void => {
      if (details.type === 'GPU') log(`[gpu] the GPU process is gone: ${details.reason}, exit code ${details.exitCode}`);
    };
    app.on('child-process-gone', processGone);
    this.disposables.push({ dispose: () => app.removeListener('child-process-gone', processGone) });
    this.disposables.push(this.systemColors);
    // before the first paint and before CoreInit takes the mirror of System colors, so both have this computer's colors
    await this.systemColors.load();
    await themeLibrary.load();
    await this.readProjectPins();
    await this.readAppearanceSchedule();
    this.followThemeClock();
    await this.agentThemes.beforeFirstPaint();
    const wallpaperCycle = new WallpaperCycle({
      state: this.themeState,
      shown: () => {
        const shown = currentBaseShown();
        return shown.builtin ? undefined : { themeId: shown.themeId, kind: shown.kind, sets: shown.look.wallpapers?.length ?? 0, minutes: shown.look.cycle?.minutes };
      },
      now: () => Date.now(),
      log: (line) => log(line),
    });
    this.disposables.push(
      this.agentThemes,
      this.themeRenderer,
      themeLibrary,
      followThemeSettings(this.platform.settings, themeLibrary),
      themeLibrary.onDidChange(() => {
        this.overlaySettings?.themesChanged();
        this.themeDock?.libraryChanged().catch(this.report('Checking the theme the editor holds'));
        const system = themeLibrary.entry(SYSTEM_THEME_ID);
        if (system?.status === 'ok') this.themeDock?.systemChanged(system.theme);
      }),
      // core writes a pick into the settings file, which this process reads when core says so; a pick of the kind that does not show
      // changes no palette, so Settings hears of it here
      this.platform.settings.onDidChange('damocles.desktop.themes', () => {
        this.overlaySettings?.themesChanged();
        this.endRelayedPreviewWhileOff();
      }),
      this.themeState.onDidChange(() => wallpaperCycleChanged()),
      onThemeInputsChange(() => this.agentThemes.inputsChanged()),
      wallpaperCycle,
      onThemeChange(() => {
        wallpaperCycle.schedule();
        this.views?.broadcastTheme();
        this.shell?.sendTheme(currentTheme('region', 'shell'));
        const rootTheme = currentTheme('root');
        this.overlay?.sendTheme(rootTheme);
        this.notifier.sendTheme(rootTheme);
        this.themeDock?.sendTheme(rootTheme);
        this.overlaySettings?.themesChanged();
        this.shellStateChanged();
      }),
      this.projects.onDidChange(() => {
        this.forgetUnlistedProjects();
        this.dropSkippedChatsOfUnlisted();
        for (const key of [...this.locateRefusals.keys()]) if (!this.projectListed(key)) this.locateRefusals.delete(key);
        this.presences.sync(this.localProjects(), (project) => this.checkedUnselected(project)).catch(this.report('Checking the project folders'));
        this.devcontainerConfigs.sync(this.devcontainerProjectKeys());
        this.adoptOpenWorktrees().catch(this.report('Recording adopted worktrees'));
        this.terminalLinks.clear();
        this.installMenu();
        this.shellStateChanged();
        this.worktreesChanged();
      }),
      this.hostStore.onDidChange(() => {
        this.publishHostNames();
        this.forgetUnlistedProjects();
        this.dropSkippedRemoteChatsOfUnlisted();
        for (const key of [...this.locateRefusals.keys()]) if (!this.projectListed(key)) this.locateRefusals.delete(key);
        // a forgotten host's; a changed OS or host id builds the authority's anew when next asked
        for (const authority of [...this.remoteRelocated.keys()]) if (authority !== 'loopback' && !this.hostAuthority(authority)) this.remoteRelocated.delete(authority);
        this.remotePresences.sync(this.checkedRemoteProjects()).catch(this.report('Checking the remote project folders'));
        // a remote project's trust is its host record's
        this.htmlPreviews?.trustChanged();
        this.servedRoots.trustChanged();
        this.devcontainerConfigs.sync(this.devcontainerProjectKeys());
        // a removed remote project hands the selection back to the selected chat's project
        if (this.remoteSelected() && !this.remoteProject(this.selectedProjectKey!)) {
          this.selectedProjectKey = undefined;
          const selected = this.views?.selected();
          // the selected chat may be one of the removed project's own, which closes after the list changed
          const selectedProject = selected && this.projectOf(selected);
          if (selected && selectedProject !== undefined && this.projectListed(selectedProject)) this.selectionChanged(selected);
        }
        this.terminalLinks.clear();
        this.recheckRemoteWorktreeRecords();
        // Open Chat in Project lists the projects in the sidebar order
        this.installMenu();
        this.shellStateChanged();
        this.worktreesChanged();
      }),
      this.shownFolders.onDidChange((shown, rootChanged) => {
        this.shell?.shownFolderChanged(shown);
        // a running search and the selected repository follow the folder shown, never its worktree's chats working
        if (rootChanged && shown.projectKey === this.selectedProjectKey) {
          this.search?.stopAll();
          this.scm?.selectedProjectChanged();
        }
        this.refreshScmRoots();
        this.refreshMenuState();
        this.shellStateChanged();
      }),
      // a revoke may name a listed project, whose previews and served pages must lose its trust
      this.trust.onDidChange(() => this.localTrustChanged()),
      this.platform.settings.onDidChange('damocles', (change) => {
        if (change.affects(BROWSER_ENABLED_KEY)) {
          this.browserTabs?.enabledChanged();
          this.refreshMenuState();
        }
        if (change.affects(NOTIFICATIONS_SETTING)) this.notificationCenter.popupPolicyChanged();
        if (change.affects(UPDATE_CHECK_AUTOMATICALLY_SETTING)) this.updates?.checkAutomaticallyChanged();
        if (change.affects(FILES_EXCLUDE_SETTING)) {
          this.fileTree?.excludeChanged();
          this.quickOpenIndex?.invalidate();
        }
        if (change.affects(SEARCH_EXCLUDE_SETTING)) this.quickOpenIndex?.invalidate();
        if (change.affects('damocles.desktop.search') || change.affects('damocles.desktop.searchEditor') || change.affects('damocles.desktop.sidebar') || change.affects(PROJECTS_VIEW_SETTING)) this.shellStateChanged();
        if (change.affects('damocles.desktop.terminal')) this.terminals?.settingsChanged();
        if (change.affects(TERMINAL_PROFILES_SETTING)) this.terminalProfiles?.refresh().catch((err: unknown) => log(`[terminal] validating the user's profiles failed: ${errorText(err)}`));
      }),
      this.state.onDidChange('global', LANGUAGE_PREFERENCE_KEY, () => localization.setLanguage(this.preferredLanguage())),
      localization.onDidChangeLanguage(() => {
        this.installMenu();
        this.tray?.relocalize();
        this.shellStateChanged();
        this.overlay?.stateChanged();
        this.themeDock?.languageChanged();
        this.notifier.stateChanged();
        // The overlay icon's description is localized.
        this.taskbar.reapply();
        this.chatsChanged();
        // the loopback host's name is localized
        this.publishHostNames();
      }),
      this.onScaleChange(() => this.taskbar.reapply()),
    );
    // macOS answers its colors for the appearance followThemeSettings has just written to nativeTheme.themeSource
    this.systemColors.readNow();
    this.devcontainerConfigs.sync(this.devcontainerProjectKeys());
    this.installMenu();

    app.on('before-quit', (event) => this.lifecycle.onBeforeQuit(event));
    app.on('window-all-closed', () => {
      // A quit closes the window itself and quits once it has disposed everything.
      if (this.lifecycle.phase === 'disposing') return;
      log('[window] all windows closed');
      if (process.platform !== 'darwin') app.quit();
    });
    // The last main-process event of a quit, so the log covers the whole shutdown.
    app.on('will-quit', () => {
      log('[shutdown] will-quit');
      this.logSink.dispose();
    });
    app.on('activate', () => this.showWindow());
    app.on('browser-window-focus', () => {
      this.recheckProjectFolders().catch(this.report('Checking the project folders'));
      this.remotePresences.check(this.checkedRemoteProjects()).catch(this.report('Checking the remote project folders'));
    });
    // A screen reader starting or stopping turns xterm's screenReaderMode on or off in every terminal.
    app.on('accessibility-support-changed', () => this.terminals?.publish());

    const secrets = this.platform.secrets;
    await runLegacySettingsMigrations(this.platform.settings, () => providerKeyStored((key) => secrets.get(key), PROVIDER_SECRET_KEYS.stepfun));
    await migrateRenamedSearchSettings(this.platform.settings, log).catch(this.report('Moving the renamed search settings'));
    const preferMoveNotice = await movePreferApiKeyFlagsToSettings(this.platform.state, this.platform.settings);
    void deleteRetiredSecrets(secrets);
    this.restoreAtLaunch = this.platform.settings.get<boolean>(RESTORE_LAYOUT_SETTING, true);
    if (!this.restoreAtLaunch) {
      this.windowLayout.clear();
      for (const chat of this.states.list()) this.states.delete(chat.panelId);
    }
    // Only the hosts with restored tabs, terminals or chats, and the last selected project's, connect at launch, and none asks:
    // an SSH host connects in the background and a prompt waits behind its sign-in banner, while its tabs show the offline
    // placeholder until it connects. The loopback daemon, which never asks, is waited for, so its tabs reopen through it.
    const authorities = this.requireAuthorities();
    // a layout saved before Forget host closed a host's tabs may still name it
    const savedEditor = withoutHosts(this.windowLayout.editor(), (authority) => this.forgottenHostAuthority(authority));
    const backups = await this.backups.list();
    const remoteState = this.requireRemoteState();
    const savedRemoteSelection = remoteState.selected();
    const savedRemote = savedRemoteSelection === undefined ? undefined : this.remoteProject(savedRemoteSelection.projectKey);
    const launchSelection = savedRemote ? savedRemoteSelection : this.states.selected();
    const hostFileAuthorities = [
      ...savedEditor.tabs.flatMap((tab) => ('authority' in tab ? [tab.authority] : [])),
      ...backups.flatMap(({ target }) => ((target.kind === 'hostSettings' || target.kind === 'outside') && target.authority !== 'local' ? [target.authority] : [])),
    ];
    const launchAuthorities = authoritiesToConnectAtLaunch({
      remoteProjectKeys: this.remoteProjects().map((project) => project.key),
      editorAuthorities: [
        ...savedEditor.tabs.flatMap((tab) => ('file' in tab ? [authorityKeyOfProject(tab.file.projectKey)] : [])),
        ...backups.flatMap(({ target }) => (target.kind === 'project' ? [authorityKeyOfProject(target.projectKey)] : [])),
        ...hostFileAuthorities,
      ],
      hostFileAuthorities,
      terminalAuthorities: this.remoteProjects().map((project) => project.authorityKey).filter((key) => remoteState.terminals(key).length > 0 || remoteState.pendingKills(key).length > 0),
      chatAuthorities: this.remoteProjects().map((project) => project.authorityKey).filter((key) => remoteState.chats(key).length > 0),
      selectedProjectKey: launchSelection?.projectKey,
      isSavedHost: (authority) => this.savedHostRecord(authority) !== undefined,
    });
    for (const key of launchAuthorities) if (this.savedHostIdOf(key) !== undefined) this.connectAuthority(key, false);
    await Promise.all(launchAuthorities.filter((key) => this.savedHostIdOf(key) === undefined).map((key) => authorities.connect(key).catch(this.report(`Connecting to ${key}`))));
    // Saved tabs come back with "Reopen where I left off"; a backup comes back either way, since it holds text the user never discarded.
    await this.requireEditorPane().restore(savedEditor, backups);
    // before any chat shows, since a selection writes both files from memory
    this.lastChats.seed([
      ...this.states.lastChats().filter((entry) => this.projectListed(entry.projectKey)),
      ...this.remoteProjects().flatMap((project) => remoteState.lastChats(project.authorityKey).filter((entry) => entry.projectKey === project.key)),
    ]);
    // before the chats reopen, which skip a project whose folder is not there
    const presenceChecked = this.presences.sync(this.localProjects());
    const launched = this.core.start();
    this.createWindow();
    // A saved selection on a remote project stays selected, its host connecting or offline; its saved chat shows once that
    // core reopened it, or as its mirrored transcript while the host is away. select shows the project synchronously, before
    // the local chats reopen, so openInitialChats shows none of them.
    if (savedRemote) this.remoteSelection.select(savedRemote.key, false).catch(this.report('Selecting the saved remote project'));
    this.tray = new AppTray(trayIcon(resourceRoot), {
      windowVisible: () => this.window?.isVisible() ?? false,
      toggleWindow: () => {
        if (this.window?.isVisible()) this.window.hide();
        else this.showWindow();
      },
      newChat: () => {
        this.showWindow();
        this.newChat(undefined).catch(this.report('New Chat'));
      },
      quit: () => app.quit(),
    }, localization);
    this.launchTabs = this.openTabsAtLaunch(launched, presenceChecked);
    await this.launchTabs;
    // a remote project's chats open once the window holds the local ones; a host not connected shows their mirrored copies
    for (const authorityKey of authorities.connectedKeys()) this.connectRemoteCore(authorityKey);
    for (const authorityKey of new Set(this.remoteProjects().map((project) => project.authorityKey))) {
      if (!authorities.connection(authorityKey) && this.savedHostIdOf(authorityKey) !== undefined) {
        this.transcripts.open(authorityKey, remoteState.chats(authorityKey), savedRemoteSelection?.sessionId).catch(this.report('Opening the mirrored transcripts'));
      }
    }
    this.markWindowReady();
    // A quit past its last question tears down the core and the updater, and a version announced now would lose its notice.
    if (this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'done') return;
    await this.adoptOpenWorktrees().catch(this.report('Recording adopted worktrees'));
    this.requireWorktrees().scanAtStartup(this.desktopProjects().map((project) => project.fsPath)).catch(this.report('Scanning for leftover worktrees'));

    if (!git.available) void this.notifications.warn(git.reason);
    if (preferMoveNotice) void this.platform.notifications.warn(preferMoveNotice);
    const hostsUnreadable = this.hostStore.unreadable();
    if (hostsUnreadable !== undefined) void this.notifications.warn(localization.t('Damocles can\'t read {0}, so remote hosts, projects and their order can\'t be changed until it is fixed and Damocles restarts: {1}', this.hostStore.filePath, hostsUnreadable));
    const remoteStateUnreadable = remoteState.unreadable();
    if (remoteStateUnreadable !== undefined) void this.notifications.warn(localization.t('Damocles can\'t read {0}, so remote chats, terminals and messages typed while a host is away aren\'t kept until it is fixed and Damocles restarts: {1}', remoteState.filePath, remoteStateUnreadable));
    updates.start();
    announceInstalledVersion({
      version,
      state: this.state.global,
      notifications: this.notifications,
      t: (message, ...args) => localization.t(message, ...args),
      openWhatsNew: (release) => this.openSettings({ section: 'about', release }),
      log: bootLog,
    }).catch(this.report('Announcing the installed version'));
  }

  // The launch's chats reopen into the first core once it is ready. A quit that began meanwhile opens nothing, and a core that
  // ended before it was ready took the crash path, whose reload reopens them into the next core. A chat that fails to open is
  // no failed start: the quit or a crash can end the core under it.
  private async openTabsAtLaunch(launched: DesktopCore, presenceChecked: Promise<unknown>): Promise<void> {
    const [ready] = await Promise.all([launched.ready.then(() => true, () => false), presenceChecked]);
    if (!ready || this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'done' || this.core.started() !== launched) return;
    // before the chats reopen: a host part cut short re-keyed them to a destination the list does not name yet
    const moved = await this.localRelocationsFrom(launched).catch((err: unknown) => {
      this.report('Looking for moved projects')(err);
      return [];
    });
    for (const view of moved) if (view.state === 'coreDone') this.movedProjects.set(folderKey(view.to), folderKey(view.from));
    await this.core.openTabs().catch(this.report('Reopening chats'));
    for (const view of moved) this.relocationReached('local', view);
  }

  // The webview normalizes what it stores.
  private preferredLanguage(): 'en' | 'el' {
    return launchLanguage(this.languageSetting, this.state.global.get<string>(LANGUAGE_PREFERENCE_KEY), app.getLocale());
  }

  private report(action: string): (err: unknown) => void {
    return (err) => log(`[desktop] ${action} failed: ${errorText(err)}`);
  }

  private requirePlatform(): DesktopPlatform {
    if (!this.platform) throw new Error('Desktop platform used before startup finished');
    return this.platform;
  }

  private requireCoreDeps(): CoreConnectionDeps {
    if (!this.coreDeps) throw new Error('Damocles Core started before startup finished');
    return this.coreDeps;
  }

  private requireScmClient(): ScmClient {
    if (!this.scmClient) throw new Error('Source control used before startup finished');
    return this.scmClient;
  }

  private requireJobLogTabs(): JobLogTabs {
    if (!this.jobLogTabs) throw new Error('Job log tabs used before startup finished');
    return this.jobLogTabs;
  }

  /** The window was focused or blurred: CI polls only while it is focused. */
  private ciWindowFocused(focused: boolean): void {
    this.forgeHost?.setWindowFocused(focused);
    this.jobLogTabs?.setWindowFocused();
  }

  private requireForgeHost(): ForgeHost {
    if (!this.forgeHost) throw new Error('Git hosting accounts used before startup finished');
    return this.forgeHost;
  }

  /** A link the user asked for: main opens or copies it, then a toast says so, or offers Push for an unpushed commit. */
  private runForgeLink(request: ForgeLinkRequest): Promise<void> {
    return runForgeLink({
      link: (asked) => this.requireForgeHost().link(asked),
      notify: this.notifications,
      t: (message, ...args) => this.requirePlatform().localization.t(message, ...args),
      render: (text) => this.requirePlatform().localization.render(text),
      push: async (repoId) => {
        if (!this.scm) throw new Error('Source control used before startup finished');
        return (await this.scm.runRequest({ op: 'push', repoId, to: false, force: false, followTags: false })).ok;
      },
      log: (line) => log(line),
    }, request);
  }

  // The running core's client; undefined before startup finished and while a reload replaces the core.
  private client(): CoreClient | undefined {
    return this.core.current()?.client;
  }

  private requireLocalClient(): CoreClient {
    const client = this.client();
    if (!client) throw new Error("This computer's Damocles engine is not running");
    return client;
  }

  // ThemeRead's screenshot: the window's page, and the chat view on screen in the chat slot over it, both in device pixels.
  private async captureWindowForTheme(): ReturnType<AgentThemesDeps['captureWindow']> {
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error('The window is closed');
    const shell = await window.webContents.capturePage();
    const scale = shell.getSize().width / Math.max(1, window.getContentBounds().width);
    const chat = this.views?.inSlot();
    if (!chat || !chat.view.getVisible()) return { shell: new Uint8Array(shell.toPNG()) };
    const bounds = chat.view.getBounds();
    const image = await chat.webContents.capturePage();
    return {
      shell: new Uint8Array(shell.toPNG()),
      chat: { png: new Uint8Array(image.toPNG()), bounds: { x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } },
    };
  }

  private requireLocalization(): DesktopLocalizationService {
    if (!this.localization) throw new Error('Localization used before startup finished');
    return this.localization;
  }

  // The primary display's scale factor changed; the taskbar badge is drawn at it.
  private onScaleChange(listener: () => void): Disposable {
    const changed = (_event: Electron.Event, display: Electron.Display, metrics: string[]): void => {
      if (metrics.includes('scaleFactor') && display.id === screen.getPrimaryDisplay().id) listener();
    };
    screen.on('display-metrics-changed', changed);
    return { dispose: () => screen.removeListener('display-metrics-changed', changed) };
  }

  private requireViews(): PanelViews {
    if (!this.views) throw new Error('No window to open a panel in');
    return this.views;
  }

  private browserEnabled(): boolean {
    return this.requirePlatform().settings.get<boolean>(BROWSER_ENABLED_KEY, true);
  }

  // Only for callers that cannot run while a reload replaces the core; a page's request runs through this.core.run instead.
  private requireCore(): DesktopCore {
    const core = this.core.current();
    if (!core) throw new Error('Core services used before startup finished or while they reload');
    return core;
  }

  private requireWorkspaces(): Workspaces {
    if (!this.workspaces) throw new Error('Workspaces used before startup finished');
    return this.workspaces;
  }

  private requireTerminals(): TerminalService {
    if (!this.terminals) throw new Error('Terminals used before startup finished');
    return this.terminals;
  }

  private async createTerminals(platform: DesktopPlatform, localization: DesktopLocalizationService): Promise<TerminalService> {
    const workspaces = this.requireWorkspaces();
    // what shell detection and the profiles' validation read; each spawn asks its backend again
    const localEnv = await workspaces.local.terminals.environment(app.getLocale());
    const catalog = new TerminalProfileCatalog({
      setting: () => platform.settings.get<unknown>(TERMINAL_PROFILES_SETTING),
      context: { platform: process.platform, env: localEnv, kind: (file) => profileFileKind(file, process.platform, (line) => log(line)) },
      log: (line) => log(line),
      onDidChange: () => {
        this.terminals?.publish();
        this.refreshMenuState();
        this.overlaySettings?.terminalProfilesChanged();
      },
    });
    this.terminalProfiles = catalog;
    // A detection that fails still validates the user's own profiles, against no detected shell.
    this.profilesDetected = workspaces.local.terminals.detectProfiles().catch((err: unknown) => {
      log(`[terminal] detecting the shells failed: ${errorText(err)}`);
      return [];
    }).then((profiles) => {
      log(`[terminal] detected shells: ${profiles.map((profile) => profile.id).join(', ') || 'none'}`);
      return catalog.setDetected(profiles);
    }).catch((err: unknown) => log(`[terminal] validating the user's terminal profiles failed: ${errorText(err)}`)).finally(() => {
      this.profilesReady = true;
      this.terminals?.publish();
    });
    const localWindowsBuild = process.platform === 'win32' ? windowsBuildNumber() : null;
    return new TerminalService({
      workspaces,
      profiles: (projectKey) => this.hostTerminalsOf(projectKey)?.profiles ?? catalog.profiles(),
      profilesReady: () => this.profilesReady,
      projects: () => this.roots.all(),
      pickerProjects: () => this.pickerRoots(),
      groupOrder: (groups) => this.hostStore?.groups(groups) ?? groups,
      hostOf: (authorityKey) => {
        const { kind, name, color } = this.shellAuthority(authorityKey);
        return { kind, name, ...(color !== undefined ? { color } : {}) };
      },
      reachable: (projectKey) => this.authorities?.connectedWorkspace(authorityKeyOfProject(projectKey)) !== undefined,
      hostDefaultProfile: (authorityKey) => {
        const hostId = this.savedHostIdOf(authorityKey);
        return hostId === undefined ? undefined : this.hostStore?.host(hostId)?.settings.defaultTerminalProfile;
      },
      currentProjectKey: () => this.currentProjectKey(),
      rootEnv: (key) => {
        const record = this.roots.resolve(key)?.worktree;
        return record ? worktreeEnvironment(record) : {};
      },
      settings: () => terminalSettings(platform.settings),
      env: (projectKey) => workspaces.forProject(projectKey).terminals.environment(app.getLocale()),
      gitCredentials: (projectKey, inherited) => this.terminalGitCredentials(projectKey, inherited),
      osOf: (projectKey) => this.filesTarget(projectKey).os,
      persistRemote: (terminals) => this.persistRemoteTerminals(terminals),
      killOnReattach: (authorityKey, id) => this.remoteState?.killOnReattach(authorityKey, id).catch(this.report('Keeping a terminal kill for its host')),
      passKeys: (target) => installedTerminalPassKeys(target),
      screenReader: () => app.isAccessibilitySupportEnabled(),
      windowsBuild: (projectKey) => {
        const host = this.hostTerminalsOf(projectKey);
        return host ? host.windowsBuild : localWindowsBuild;
      },
      persisted: () => this.windowLayout.terminals(),
      persist: (terminals) => this.windowLayout.setTerminals(terminals),
      onDidChange: () => this.refreshMenuState(),
      editorTabsChanged: () => this.editorPane?.terminalTabsChanged(),
      showEditorTab: (id) => this.editorPane?.showTerminalTab(terminalTabId(id), { focus: true }),
      showPanel: () => this.showTerminalPane(),
      spawnFailed: (message) => localization.t('The shell could not start: {0}', message),
      launchFailed: ({ reason, file, cwd }) => {
        if (reason === 'invalidDirectory') return localization.t('The shell could not start in {0}: the folder does not exist.', cwd);
        if (reason === 'notAnExecutable') return localization.t('The shell could not start: {0} is not a program Windows can run.', file);
        return localization.t('The shell could not start: a software restriction policy blocks {0}.', file);
      },
      log: (line) => log(line),
      platform: process.platform,
      // the chats' home target, so a terminal started with no project open is in the folder the breadcrumb names
      homedir: homeDirectory(),
      confirmKill: async (entries) => (await this.ask(killQuestion(entries, (message, ...args) => localization.t(message, ...args)))) === 0,
    });
  }

  // The selected project, else the first one; undefined with no project open.
  private currentProjectKey(): string | undefined {
    const projects = this.workspaceProjects();
    const selected = this.selectedProjectKey ?? this.client()?.defaultTarget()?.key;
    const key = projects.find((project) => project.key === selected)?.key ?? projects[0]?.key;
    // a new terminal starts in the project's shown folder (D31)
    return key === undefined ? undefined : this.shownFolders.rootKeyOf(key);
  }

  // The New Terminal picker's folders: each open project, the current one as its shown folder.
  private pickerRoots(): RootProject[] {
    const current = this.currentProjectKey();
    return this.workspaceProjects().map((project) => {
      const shown = current !== undefined && parseRootKey(current)?.projectKey === project.key ? this.roots.resolve(current) : undefined;
      return shown ?? { ...project, root: { projectKey: project.key } };
    });
  }

  // Quick Open's roots (D31): the selected project's shown folder, and the other projects' folders.
  private quickOpenRoots(): RootProject[] {
    const selected = this.selectedProjectKey ?? this.client()?.defaultTarget()?.key;
    return this.workspaceProjects().map((project) => (project.key === selected ? this.roots.resolve(this.shownFolders.rootKeyOf(project.key)) : undefined) ?? { ...project, root: { projectKey: project.key } });
  }

  private startCoreServices(): DesktopCore {
    // core's exit is reported on a later turn, once hosted exists
    const restarted = this.coreStarted;
    this.coreStarted = true;
    const core = startDesktopCore(this.requireCoreDeps(), {
      endedCores: [...this.endedCores],
      restarted,
      // a new core's registry serves them while registry.json does not parse, as the one before it did
      worktreeRecords: [...this.worktreeRecords.records()],
      crashed: (pid, how) => this.coreCrashed(hosted, pid, how),
      leftLeases: (pid) => this.endedCores.push({ pid, endedAt: Date.now() }),
    });
    const { client } = core;
    // The previous core's chats closed with it, and its foreign view proxies.
    this.forgetChatsOf('local');
    this.foreignViews.localCoreStarted();
    // also after a core that ended before it was ready: a remote attach's pending values, or an older daemon's attach, wait for these reads
    void core.ready.catch(() => undefined).then(() => this.userRelays?.authChanged()).catch(this.report('Reading the sign-ins for remote chats'));
    void core.ready.catch(() => undefined).then(() => this.userRelays?.mcpChanged()).catch(this.report('Reading the personal MCP servers for remote chats'));
    void core.ready.catch(() => undefined).then(() => this.userRelays?.forgesChanged()).catch(this.report('Reading the Git hosting servers for remote hosts'));
    // a Forget host while the engine was halted left that host's bindings and host defaults, which this core drops
    void core.ready.then(() => this.keepForgeHosts(client), () => undefined).catch(this.report('Dropping the Git hosting bindings of forgotten hosts'));
    void core.ready.then(() => this.readProjectLooks(client), () => undefined).catch(this.report('Reading the project looks'));
    // a keep-changes countdown the previous core left: this core reverts it at its start
    void core.ready.then(() => this.agentThemes.coreStarted(), () => undefined).catch(this.report('Reading the unsettled theme change'));
    // a theme link that launched the app opens once the window and this core are ready
    void Promise.all([this.windowReady, core.ready]).then(() => this.themeSharing.markReady(), () => undefined);
    // a finished move whose host part an earlier core's end cut short; the launch's core is asked before its chats reopen
    if (restarted) void core.ready.then(() => this.localRelocationsReached(hosted), () => undefined).catch(this.report('Looking for moved projects'));
    for (const key of [...this.catalogRows.keys()]) if (authorityKeyOfProject(key) === 'local') this.catalogRows.delete(key);
    const subscriptions = [
      // a staged install's update reaches the remote core that asked for it, else the Settings install card
      client.onThemesInstallUpdated((preview) => {
        this.relayedConsents.installUpdated(preview);
        if (!this.relayedInstalls.updated(preview)) this.themeSharing.installUpdated(preview);
      }),
      client.onThemesInstallProgress((progress) => {
        if (!this.relayedInstalls.progress(progress)) this.themeSharing.installProgress(progress);
      }),
      // core dropped an install that waited too long: the remote core that asked for it hears, else the Settings install card
      client.onThemesInstallExpired((installId) => {
        const authority = this.relayedInstalls.expired(installId);
        if (authority !== undefined) this.relayedConsents.installEnded(authority, installId);
        else this.themeSharing.installExpired(installId);
      }),
      client.onThemesStoreUpdated((view, listRead) => this.themeSharing.storeUpdated(view, listRead)),
      client.onWorktreeState((event) => this.onWorktreeState(event)),
      client.onFoldersChanged(() => {
        this.followSelectedChat();
        this.shellStateChanged();
      }),
      client.onAllChatsClosed(() => log('[chats] the last loaded chat closed')),
      // remote hosts' takeover follows this computer's managed servers (clientForges)
      client.onForgeChanged(() => {
        this.userRelays?.forgesChanged().catch(this.report('Reading the Git hosting servers for remote hosts'));
      }),
      client.onActivity((panelId, activity) => this.onChatActivity(panelId, activity)),
      client.onChatChanges((panelId, totals, generation) => this.chatReviews.chatChanged(panelId, totals, generation)),
      client.onTurnSettled((panelId, outcome) => {
        const panel = this.panelOfCore(panelId);
        if (panel) this.chatsChanged(this.projectOf(panel));
        this.notificationCenter.turnSettled(panelId, outcome);
        this.scheduleRetention();
      }),
      client.onUsageThreshold((crossing) => this.notificationCenter.usageThreshold(crossing)),
      client.onCatalogChanged((projectKey) => {
        if (projectKey === undefined) this.catalogRows.clear();
        else this.catalogRows.delete(projectKey);
        this.chatsChanged(projectKey);
        this.refreshSelectedCatalog();
      }),
      // the user chose Open here on a lease refusal: the selection goes through the same path that was refused
      client.onTakeover((sessionId) => {
        if (this.views) this.selectChat(sessionId, 'local').catch(this.report('Opening a conversation here'));
      }),
      client.onDesignChanged((designId, paths) => this.designPreviews?.designChanged('local', designId, paths)),
      // a pick or an undo changes the history and the settings, not only theme files, so Settings lists again either way
      client.onThemesChanged(() => {
        // core wrote the picked looks into the user settings before it said so, and a file watch can miss that write
        this.platform?.settings.reload();
        this.themeLibrary?.coreChanged().then(() => this.agentThemes.themesChanged()).catch(this.report('Reading the theme files'));
        const reads = [
          this.readProjectPins().catch(this.report('Reading the project characters')),
          this.readProjectLooks(client).catch(this.report('Reading the project looks')),
          this.readAppearanceSchedule().catch(this.report('Reading the theme schedule')),
        ];
        // core also says so after it wrote a wallpaper's or a sprite's analysis
        invalidateWallpaperStats();
        // after the reads, so the list Settings asks for next is never older than the change it was told of
        void Promise.all(reads).then(() => this.overlaySettings?.themesChanged());
      }),
      client.onWorktreeRecords((records) => this.worktreeRecords.apply(records)),
      client.onRelocationsChanged(() => {
        this.relocationsChanged('local', client);
        // a pending relocation's looks show under where it leads
        this.readProjectLooks(client).catch(this.report('Reading the project looks'));
      }),
      client.onNewChatInWorktree((projectPath, worktreeId) => {
        this.newChatInWorktree({ projectKey: folderKey(projectPath), worktreeId }).catch(this.newChatInWorktreeFailure());
      }),
      client.onNewChatInProject((projectPath) => {
        this.newChat(folderKey(projectPath)).catch(this.shellFailure('New Chat', 'Damocles could not open a new conversation: {0}'));
      }),
      // a sign-in or out in the User tab reaches every attached remote core as a clientAuth delta
      client.onClientAuthChanged(() => {
        this.userRelays?.authChanged().catch(this.report('Reading the sign-ins for remote chats'));
      }),
      // a marked personal server or its tools changed: every attached remote core hears the new list
      client.onRelayedMcpChanged(() => {
        this.userRelays?.mcpChanged().catch(this.report('Reading the personal MCP servers for remote chats'));
      }),
      client.onForeignPost((viewId, message) => this.foreignViews.foreignPost(viewId, message)),
      this.requireScmClient().attach(client),
      this.requireForgeHost().attach(client),
    ];
    // the new core holds no job log watch
    this.jobLogTabs?.coreAttached();
    const hosted: DesktopCore = {
      authority: 'local',
      client,
      pid: core.pid,
      terminalToggleChanged: () => core.terminalToggleChanged(),
      ready: core.ready,
      isReady: () => core.isReady(),
      hasEnded: () => core.hasEnded(),
      dispose: async () => {
        this.overlaySettings?.coreEnded(client);
        this.agentThemes.coreEnded();
        // this core's cards end with it; a remote chat's draft capture is RelayedConsents' to end
        clearCardThemes('local');
        await this.beforeCoreDispose();
        for (const subscription of subscriptions) subscription.dispose();
        const views = (this.views?.chats() ?? []).filter((view) => view.authority === 'local');
        this.keptPermissions.coreEnded(views.map((view) => view.panelId), (viewId) => client.chatOfView(viewId)?.permissions);
        // A chat whose restore waits for a stale lease keeps that session as its restore target for the next core.
        for (const chat of client.chats()) {
          if (chat.restoring !== undefined) views.find((view) => view.panelId === chat.viewId)?.keepRestoreTarget(chat.restoring);
        }
        await core.dispose();
      },
    };
    return hosted;
  }

  // Core asks for a reload (lifecycle.reload, the chat's Reload after an extension change): bounded as crashes are, so a core
  // cannot fork cores without end.
  private coreRequestedReload(): Promise<void> {
    const decision = restartDecision(this.coreReloads, performance.now());
    this.coreReloads = decision.crashes;
    if (!decision.restart) {
      log(`[core] refused a reload core asked for: ${RESTART_LIMIT} in 5 minutes already`);
      return Promise.reject(new Error('The Damocles engine asked to restart too often'));
    }
    return this.core.reload();
  }

  // Core's process ended without main asking: VS Code's extension host policy restarts it at most RESTART_LIMIT times in
  // RESTART_WINDOW_MS, then leaves it down with a notice whose Restart starts it again (docs/invariants.md "Desktop host").
  private coreCrashed(core: DesktopCore, pid: number | undefined, how: string): void {
    // The quit stopped the host, which neither restarts nor halts the engine now.
    const phase = this.lifecycle.phase;
    if (phase === 'disposing' || phase === 'done') {
      log(`[core] stopped unexpectedly (pid ${pid ?? 'unknown'}, ${how}) during the quit`);
      return;
    }
    const decision = restartDecision(this.coreCrashes, performance.now());
    this.coreCrashes = decision.crashes;
    const { t } = this.requireLocalization();
    if (decision.restart) {
      log(`[core] stopped unexpectedly (pid ${pid ?? 'unknown'}, ${how}); restarting (${decision.count} of ${RESTART_LIMIT} in 5 minutes)`);
      void this.notifications.info(t('The Damocles engine stopped unexpectedly and was restarted.'));
      this.core.restart(core).catch(this.report('Restarting the engine'));
      return;
    }
    log(`[core] stopped unexpectedly (pid ${pid ?? 'unknown'}, ${how}); not restarting after ${RESTART_LIMIT} restarts in 5 minutes`);
    this.core.halt().catch(this.report('Stopping the engine'));
    const restart = t('Restart');
    this.haltNotice?.withdraw();
    const notice = this.notificationCenter.stickyNotice('error', t('The Damocles engine stopped unexpectedly {0} times in 5 minutes, so it was not restarted.', RESTART_LIMIT + 1), [restart]);
    this.haltNotice = notice;
    notice.answer.then((choice) => {
      if (choice === 0) this.restartEngine('local');
    }, this.report('The engine notice'));
  }

  // Restart Engine and the halt notice's Restart: the crash count starts again, and a new core replaces the running or
  // halted one. A remote host's engine restarts in its daemon, which then reports the new epoch. Either lets a design
  // renderer that ended too often start again.
  private restartEngine(authority: string): void {
    this.designRenderer?.reset();
    if (authority === 'local') {
      this.coreCrashes = [];
      this.core.reload().catch(this.report('Restarting the engine'));
      return;
    }
    const failed = this.shellFailure('Restart Engine', 'Damocles could not restart the engine: {0}');
    const remote = this.remoteCores.get(authority);
    if (!remote || !this.authorities?.connection(authority)) {
      failed(this.notConnected(authority));
      return;
    }
    // a connection lost mid-restart reports the host as disconnected, not the transport's own error
    remote.restart().catch((err: unknown) => failed(this.authorities?.connection(authority) ? err : this.notConnected(authority)));
  }

  // The title bar's pill and the menu follow the halt; once the engine runs again the halt notice offers Restart no more.
  private engineHaltChanged(): void {
    if (!this.core.halted()) {
      this.haltNotice?.withdraw();
      this.haltNotice = undefined;
    }
    this.userRelays?.engineHaltedChanged();
    this.shellStateChanged();
  }

  // The view for a panel core creates: a chat core opens itself, or a browser page of a loaded chat.
  private createCoreView(panelId: string, create: Omit<PanelCreate, 'owner' | 'parent'> & { readonly owner?: RelayView; readonly parent?: RelayView }, authority = 'local'): RelayView {
    const { owner, ...rest } = create;
    const options: PanelOptions = { ...rest, localResourceRoots: [...rest.localResourceRoots], ...(owner ? { owner } : {}) };
    if (options.kind === 'chat') return this.openCoreChat(options, panelId, authority);
    // the browser runs on this computer; the refusal goes back to the core, so it never names the host
    if (authority !== 'local') throw new Error('Browser pages open only in chats on this computer');
    return this.requireViews().create({ options, panelId });
  }

  private createWindow(): void {
    this.states.unseal();
    this.windowLayout.unseal();
    this.remoteState?.unseal();
    const placement = this.windowLayout.window();
    const restored = placement && clampToWorkAreas(placement.bounds, screen.getAllDisplays().map((display) => display.workArea));
    const bounds = restored ?? defaultWindowBounds(screen.getPrimaryDisplay().workArea);
    const mac = process.platform === 'darwin';
    const window = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      title: 'Damocles',
      ...(mac ? {} : { icon: windowIcon(resourceRoot) }),
      backgroundColor: shownBackground(),
      // AD7: frameless. macOS draws its traffic lights; on Windows and Linux the shell's title bar draws the window controls,
      // since native ones (titleBarOverlay) paint above every view and the overlay's scrim cannot cover them.
      titleBarStyle: 'hidden',
      ...(mac ? { trafficLightPosition: { x: 12, y: 13 } } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload-shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const tracker: WindowBoundsTracker = { applied: undefined, normal: bounds };
    sizeExactly(window, bounds, tracker);
    this.windowBounds = tracker;
    const trackNormal = (): void => refreshNormalBounds(window, tracker);
    window.on('resize', trackNormal);
    window.on('move', trackNormal);
    // The menu's accelerators keep working with the menu bar hidden; the title bar logo pops the menu up.
    if (!mac) window.setMenuBarVisibility(false);
    if (placement?.maximized) window.maximize();
    if (placement?.fullScreen) window.setFullScreen(true);
    // a blurred window polls no CI and plays no moving wallpaper
    window.on('blur', () => {
      this.ciWindowFocused(false);
      this.motionChanged({ focused: false });
      this.refreshNoticeHolds();
    });
    window.on('focus', () => {
      this.ciWindowFocused(true);
      this.motionChanged({ focused: true });
      this.refreshNoticeHolds();
    });
    this.ciWindowFocused(window.isFocused());
    this.motionChanged({ focused: window.isFocused(), minimized: window.isMinimized() });
    const overlay = new OverlayHost({
      window,
      preloadPath: path.join(__dirname, 'preload-overlay.js'),
      state: () => this.overlayState(),
      focusOutside: () => this.focusOn('chat'),
      // Activation is asynchronous on X11 and Electron focuses the window's own page as it activates, so the overlay takes
      // focus from the window's focus event.
      awaitActivation: () => {
        this.focusOnActivation = 'overlay';
        this.flash('overlay', true);
      },
      popupsClosed: () => {
        if (this.focusOnActivation === 'overlay') this.focusOnActivation = undefined;
        this.flash('overlay', false);
      },
      modeChanged: () => this.refreshNoticeHolds(),
      // A badge drawn while the page could not draw is a dot.
      canRasterize: () => this.taskbar.reapply(),
      log: (line) => log(line),
    });
    handleCenterChannels(overlay, this.notificationCenter);
    handleAboutChannels(overlay, this.aboutDeps());
    registerConnectChannels(overlay, this.requireRemoteHosts());
    // the change pushes live as long as this window's overlay; macOS opens a new window after a close
    const unregisterForgeOverlay = registerForgeOverlayChannels(overlay, this.requireForgeHost());
    // the New menu's options and the Merge dialog's Generate answer for the request open in this overlay
    overlay.handleWhileOpen(OVERLAY_CHANNELS.worktreeOptions, () => overlay.isOpen('newChatMenu'), () => {
      const open = overlay.openRequestOf('newChatMenu');
      if (!open) throw new Error('No New menu is open');
      return this.worktreeOptions(open.projectKey);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.terminalPickProfiles, () => overlay.isOpen('newTerminal'), (raw) => serveTerminalPick(this.terminalPick, raw, this.terminalPickHost()));
    overlay.handleWhileOpen(OVERLAY_CHANNELS.continueWorktrees, () => overlay.isOpen('newChatMenu'), () => {
      const open = overlay.openRequestOf('newChatMenu');
      if (!open) throw new Error('No New menu is open');
      return this.worktreesOf(authorityKeyOfProject(open.projectKey)).continueWorktrees(this.worktreeProject(open.projectKey));
    });
    // the open Merge dialog is one controller's, local or a remote host's
    overlay.handleWhileOpen(OVERLAY_CHANNELS.worktreeGenerateMessage, () => overlay.openRequestOf('worktreeDialog')?.dialog === 'mergeMessage', async () => {
      for (const controller of [this.requireWorktrees(), ...this.remoteWorktrees.values()]) {
        const generated = await controller.generateForOpenDialog();
        if (generated) return generated;
      }
      return null;
    });
    const quickOpenPicker = new QuickOpenPicker(
      overlay,
      this.requireQuickOpenIndex(),
      () => ({ currentProjectKey: this.currentProjectKey(), recent: this.requireEditorPane().recentFiles() }),
      { capture: () => this.menuState(), list: (context) => this.requirePalette().list(context) },
      (line) => log(line),
    );
    const browserTabs = new BrowserTabs({
      editor: this.requireEditorPane(),
      window,
      setPages: (chatPanelId, pages) => this.states.setPages(chatPanelId, pages),
      retainingStates: () => views.retainingStates,
      browserEnabled: () => this.browserEnabled(),
      newPage: async (chat) => {
        // a remote chat's page opens in its host's own context on this computer, a tab of that chat
        if (chat.authority !== 'local') await this.foreignViews.attachView(chat.panelId, chat.authority);
        return this.core.run('New Browser Page', (core) => core.client.newBrowserPage(chat.panelId));
      },
      remoteAddress: (chat, url) => this.remotePageAddress(chat, url),
      forwardedFrom: (chat, url) => this.forwardedFrom(chat, url),
      servedMappings: (chat) => this.servedRoots.mappings('local', chat.panelId),
      openExternal: (url) => this.requirePlatform().shell.openExternal(url),
      openExternalFailed: () => void this.notifications.error(this.requireLocalization().t('Damocles could not open the page in the system browser.')),
      copy: (text) => this.requirePlatform().clipboard.writeText(text),
      focusAway: () => this.focusAwayFromPage(),
      focusPart: (step) => this.focusPart(step),
    });
    const themeDock = this.createThemeDock(window, overlay);
    // Every view added goes under the editor dock, and the dock under the overlay.
    const restack = (): void => {
      themeDock.raise();
      overlay.restack();
    };
    const designPreviews = this.createDesignPreviews(window, () => views.retainingStates, restack);
    this.htmlPreviews?.attach(window, restack);
    const pageTabs: BrowserTabSource = {
      tabs: () => [...browserTabs.tabs(), ...designPreviews.tabs()],
      close: (tabId) => (designPreviews.holds(tabId) ? designPreviews.close(tabId) : browserTabs.close(tabId)),
      activeChanged: (tabId) => {
        browserTabs.activeChanged(tabId);
        designPreviews.activeChanged(tabId);
      },
      copyPath: (tabId) => (designPreviews.holds(tabId) ? designPreviews.copyPath(tabId) : Promise.resolve()),
      mention: (tabId) => (designPreviews.holds(tabId) ? designPreviews.mention(tabId) : Promise.resolve()),
      focusPage: (tabId) => (designPreviews.holds(tabId) ? designPreviews.focusPage(tabId) : browserTabs.focusPage(tabId)),
    };
    const views: PanelViews = new PanelViews(
      {
        window,
        preloadPath: path.join(__dirname, 'preload-panel.js'),
        resourceRoot,
        pageStrings: () => this.pageStrings(),
        language: () => this.requireLocalization().language,
        hostLabel: (authority) => this.panelHostLabel(authority),
        hostNames: () => this.panelHostNames(),
        onHostAction: (panel, action) => this.panelHostAction(panel, action),
        onAllowYolo: async (panel, anchor) => {
          const rect = parseRect(anchor);
          if (!rect) throw new Error('Malformed allow YOLO anchor');
          // the question goes with the page that asked
          const closed = new AbortController();
          const watch = panel.onDispose(() => closed.abort());
          try {
            return await this.allowHostYolo(panel.authority, panel.overlayRect(rect, window.webContents.getZoomFactor()), closed.signal);
          } finally {
            watch.dispose();
          }
        },
        connection: (panel) => this.panelConnection(panel),
        onQueueAction: (panel, action) => this.heldMessageAction(panel, action),
        takeCoreMessage: (panel, type, json) => (this.takeHeldVerdict(panel, type, json) ? undefined : this.relayedConsents.card(panel, type, json)),
        states: this.states,
        pages: {
          pageAdded: (page) => browserTabs.pageAdded(page),
          pageRemoved: (page) => browserTabs.pageRemoved(page),
          pageChanged: (page) => browserTabs.pageChanged(page),
          pageRevealed: (page) => browserTabs.pageRevealed(page),
          chatSelected: (chat) => designPreviews.chatSelected(chat, () => browserTabs.chatSelected(chat)),
          chatClosed: (chat) => {
            browserTabs.chatClosed(chat);
            designPreviews.chatClosed(chat);
          },
        },
        log: (line) => log(line),
        onChange: () => this.viewsChanged(),
        onRestack: restack,
        onReveal: (chat) => this.showChat(chat, { focus: true }),
        onRendererGaveUp: (panel) => this.chatGaveUp(panel),
        onRendererGone: () => this.rendererCrashed('a chat page'),
        onSavedSessionChange: (chat) => {
          // a remote chat's screenshot grant ends with its session, on this signal or the chats mirror's, whichever lands first
          if (chat.authority !== 'local') this.relayedConsents.pageSession(chat, chat.savedSessionId);
          this.chatChanged(chat);
        },
        onThemeApplied: (panel, revision) => this.themeAcks.acknowledged(panel.webContents, revision),
        onDocumentGone: (panel) => this.themeAcks.forget(panel.webContents),
        onModalChange: (chat) => {
          if (this.views?.selected() === chat) this.shell?.stateChanged();
        },
        popupOpen: () => overlay.mode === 'full',
        withholds: (chat) => this.chatWithheld(chat),
        openRemoteLink: (authority, url) => { this.requireOpenUrl().userClick(authority, url).catch(this.report('Open Link')); },
      },
      (absolutePath) => appResourceUri(resourceRoot, absolutePath),
    );
    restack();
    const overlaySettings = new OverlaySettings({
      overlay,
      settings: this.requirePlatform().settings,
      target: (scope) => this.settingsTarget(scope),
      scopes: () => this.settingsScopes(),
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      relaunch: () => {
        void this.lifecycle.relaunch();
      },
      resetLayout: () => this.resetLayout(),
      themes: {
        list: () => this.overlayThemes(),
        act: (action) => this.themeCommands.act(action),
        setStoreEnabled: (enabled) => this.core.run('The community store setting', (core) => core.client.themesStoreSetEnabled(enabled)),
      },
      terminalProfiles: () => this.terminalProfileReport(),
      log: (line) => log(line),
      languageAtLaunch: this.languageSetting,
      knownHost: (hostId) => this.hostStore?.host(hostId) !== undefined,
      allowYolo: (authority, anchor) => this.allowHostYolo(authority, anchor),
      signIn: async (authority) => {
        const hostId = this.savedHostIdOf(authority);
        if (hostId === undefined) throw new Error('The settings tab names no saved host');
        await this.requireRemoteHosts().openConnect(hostId, { purpose: 'signIn' }).catch(this.shellFailure('Connect to Host', 'Damocles could not open the Connect dialog: {0}'));
      },
      hostAway: (authority) => this.settingsHostAway(authority),
      closed: () => this.themeSharing.settingsClosed(),
    });
    const detachSharing = this.themeSharing.attach(overlay, () => overlaySettings.showing());
    const shell: ShellHost = new ShellHost(window, this.shellActions(views, browserTabs, overlay, window), (line) => log(line), () => this.shellGaveUp(shell));
    // custom CSS never enters the shell's HTML: ShellHost gives each loaded document the latest theme, which its preload sets as textContent
    shell.sendTheme(currentTheme('region', 'shell'));
    const terminals = this.requireTerminals();
    terminals.attach({ state: (state) => shell.terminalState(state), data: (data) => shell.terminalData(data), screen: (screen) => shell.terminalScreen(screen), focus: (id) => shell.focusTerminal(id) });
    // A restored shell's first output (its banner and prompt) is pushed only to a loaded page, after ShellHost's own load handler.
    const firstLoad = new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()));
    // Toggle Terminal awaits it, so it always resolves.
    this.terminalsRestored = Promise.all([this.profilesDetected, firstLoad]).then(() => {
      if (this.shell !== shell) return;
      // every saved host's kept terminals: each holds its slot, reconnecting, until its host reattaches it
      const remoteState = this.remoteState;
      terminals.restore(remoteState ? [...new Set(this.remoteProjects().map((project) => project.authorityKey))].flatMap((key) => remoteState.terminals(key)) : []);
      for (const authorityKey of this.authorities?.connectedKeys() ?? []) this.reattachRemoteTerminals(authorityKey);
    }).catch((err: unknown) => log(`[terminal] restoring the window layout's terminals failed: ${errorText(err)}`));
    const savePlacement = (): void => this.saveWindowPlacement(window, tracker);
    for (const event of ['resized', 'moved', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      window.on(event as 'resized', savePlacement);
    }
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      window.on(event as 'maximize', () => this.shellStateChanged());
    }
    // Closing the window closes its chats but keeps their state, so the next window or launch restores them. Unsaved editors
    // go first: kept as backups with "Reopen where I left off", else the user saves or discards them, or cancels the close.
    // Running terminals are asked about first (G22): that question changes nothing, so a cancel leaves the editors untouched.
    window.on('close', (event) => {
      const editor = this.editorPane;
      if (!this.closeRelease.terminalsAgreed || (editor && !editor.isReleased)) {
        event.preventDefault();
        this.lifecycle.release().then((close) => {
          if (close && !window.isDestroyed()) window.close();
        }, (err: unknown) => log(`[window] keeping the window open: ${errorText(err)}`));
        return;
      }
      overlaySettings.close();
      this.sealPersistedState(window, tracker);
      views.retainStatesOnClose(true);
      for (const panelId of views.panelIds()) views.panel(panelId)?.close();
    });
    let closed!: (requests: Promise<void>) => void;
    this.windowClosed = new Promise<void>((resolve) => (closed = resolve));
    window.on('closed', () => {
      log('[window] closed');
      // Nothing waits for this window to activate any more; the next window starts with no pending focus.
      this.focusOnActivation = undefined;
      this.flash('overlay', false);
      // A window left open would keep the app from quitting on Windows and Linux.
      this.notifier.dispose();
      this.designRunner?.closeAll('The Damocles window closed.');
      this.designRenderer?.stop('the Damocles window closed');
      this.search?.stopAll();
      this.terminals?.closeWindow();
      // the next window reattaches the remote terminals the daemons keep
      this.reattachedAuthorities.clear();
      shell.dispose();
      overlaySettings.dispose();
      detachSharing();
      unregisterForgeOverlay();
      themeDock.dispose();
      this.themeRenderer.closePage('The Damocles window closed.');
      this.agentThemes.windowClosed();
      setThemePreview(undefined);
      overlay.dispose();
      this.ciWindowFocused(false);
      if (this.window === window) {
        this.window = undefined;
        this.views = undefined;
        this.browserTabs = undefined;
        this.designPreviews?.dispose();
        this.designPreviews = undefined;
        this.htmlPreviews?.detach();
        this.pageTabs = undefined;
        this.shell = undefined;
        this.overlay = undefined;
        this.overlaySettings = undefined;
        this.quickOpenPicker = undefined;
        this.themeDock = undefined;
      }
      this.tray?.relocalize();
      closed(Promise.all([shell.settled(), overlay.settled()]).then(() => undefined));
    });
    // latency pings run only while a shown window shows one of the host's projects
    window.on('show', () => {
      this.tray?.relocalize();
      this.publishVisibleAuthorities();
      this.refreshNoticeHolds();
    });
    window.on('hide', () => {
      this.tray?.relocalize();
      this.publishVisibleAuthorities();
      this.refreshNoticeHolds();
    });
    window.on('minimize', () => {
      this.publishVisibleAuthorities();
      this.motionChanged({ minimized: true });
      this.refreshNoticeHolds();
    });
    window.on('restore', () => {
      this.publishVisibleAuthorities();
      this.motionChanged({ minimized: false });
      this.refreshNoticeHolds();
    });
    onWindowActivated(window, () => {
      this.notificationCenter.windowFocused();
      this.flash('overlay', false);
      const viewed = this.viewedChat();
      if (viewed) this.notificationCenter.chatViewed(viewed);
      const restore = this.activationFocus.activated();
      if (this.focusOnActivation !== undefined) this.focusOn(this.focusOnActivation);
      else if (restore && !restore.isDestroyed() && this.windowView(restore)?.getVisible()) restore.focus();
    });
    onWindowDeactivated(window, () => this.activationFocus.deactivated());
    // Windows ends the session: the remote runs are kept with no question
    window.on('session-end', () => this.quitUnattended('the Windows session ends'));
    this.window = window;
    this.closeRelease.windowOpened();
    this.notificationCenter.windowOpened();
    this.taskbar.reapply();
    this.views = views;
    this.browserTabs = browserTabs;
    this.designPreviews = designPreviews;
    this.pageTabs = pageTabs;
    this.shell = shell;
    this.overlay = overlay;
    this.overlaySettings = overlaySettings;
    this.quickOpenPicker = quickOpenPicker;
    this.themeDock = themeDock;
    this.refreshNoticeHolds();
    this.editorPane?.reopened();
    overlay.handleWhileOpen(OVERLAY_CHANNELS.projectLookImage, () => overlay.isOpen('projectLook'), () => this.projectLookImage(window));
    overlay.load();
    shell.load();
  }

  /** Shows the settings modal in the overlay, attached to the selected chat (plan AD2); a closed window opens first. */
  private openSettings(target: SettingsTarget, scope?: 'machine'): void {
    this.showWindow();
    const overlay = this.overlay;
    const settings = this.overlaySettings;
    if (!overlay || !settings) return;
    overlay.whenLoaded().then(() => settings.show(target, scope)).finally(() => this.remoteHosts?.dropUnshownRuns()).catch(this.report('Settings'));
  }

  private requireUpdates(): UpdateService {
    if (!this.updates) throw new Error('Updates used before startup finished');
    return this.updates;
  }

  private versionInfo(): VersionInfo {
    return {
      version: this.requirePlatform().appInfo.version,
      packaged: app.isPackaged,
      platform: shellPlatform(process.platform),
      arch: process.arch,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    };
  }

  private aboutDeps(): AboutDeps {
    const releaseNotes = this.releaseNotes;
    if (!releaseNotes) throw new Error('Release notes used before startup finished');
    return {
      updates: this.requireUpdates(),
      releaseNotes,
      versionInfo: () => this.versionInfo(),
      clipboard: this.requirePlatform().clipboard,
      showLog: () => showLog(),
      openSettings: (target) => this.openSettings(target),
    };
  }

  // The shell's pill follows every change; the About section only while the settings show.
  private updateChanged(snapshot: UpdateSnapshot): void {
    this.shell?.updateChanged(snapshot);
    if (this.overlay?.isOpen('settings')) this.overlay.send(OVERLAY_CHANNELS.updateState, snapshot);
    this.refreshMenuState();
  }

  // The selected chat's core panel once core has set it up, else the chat a host prompt would use: one being opened, or a
  // new one on the default project. A remote chat's User tab is a local core panel (promptTarget), its host and Project tabs
  // the chat's own core with that tab's scope.
  private async settingsTarget(scope: SettingsScope | undefined): Promise<SettingsAttachTarget | undefined> {
    await this.beforeSettingsTarget();
    const remoteChat = this.views?.selected();
    // the selected remote chat reopens with its core, which its host and Project tabs wait for
    if (!remoteChat && scope !== 'user' && this.reopeningSelectedAuthority() !== undefined) return undefined;
    if (remoteChat && remoteChat.authority !== 'local' && scope !== 'user') {
      const remote = this.remoteCores.get(remoteChat.authority);
      if (!remote) return undefined;
      return lookupOnUpCore(remote.host, async (core) => {
        const corePanelId = (await this.restoredCorePanel(remoteChat)).corePanelId;
        return corePanelId === undefined ? undefined : { host: core.client, panelId: corePanelId, scope: scope ?? 'machine', page: this.settingsPage(remoteChat.authority, core.client, corePanelId) };
      });
    }
    return this.core.run('Settings', async (core) => {
      // read again: a reload under way reopens the selected chat before this runs
      const selected = this.views?.selected();
      if (selected && selected.authority === 'local') {
        const corePanelId = (await this.restoredCorePanel(selected)).corePanelId;
        return corePanelId === undefined ? undefined : { host: core.client, panelId: corePanelId, page: this.settingsPage('local', core.client, corePanelId) };
      }
      const scoped = scope !== undefined ? { scope } : {};
      // a remote chat reopening selected keeps the selection, so its User tab opens no chat that would take it
      if (!selected && this.reopeningSelectedAuthority() === undefined) {
        const panelId = await core.client.promptTarget();
        return panelId === undefined ? undefined : { host: core.client, panelId, ...scoped, page: this.settingsPage('local', core.client, panelId) };
      }
      // A remote chat's User tab is a local chat's: the last viewed one, else the one promptTarget opens, which stays hidden
      // so the selection stays on the remote chat, and stays loaded while the settings show.
      const local = (this.views?.chats() ?? []).filter((chat) => chat.authority === 'local').sort((a, b) => (this.lastViewed.get(b) ?? 0) - (this.lastViewed.get(a) ?? 0))[0];
      this.settingsLocalChat = local;
      // the hold above stops later unloads only: one core was asked for before it may still close the chat
      if (local) await this.unloads.settled(local);
      let panelId = local && !local.isDisposed ? (await this.restoredCorePanel(local)).corePanelId : undefined;
      if (panelId === undefined) {
        const opened = await this.settingsOpening.run(() => core.client.promptTarget(), (chat) => this.showChat(chat, { focus: true }));
        panelId = opened.panelId;
        if (opened.chat) this.settingsLocalChat = opened.chat;
      }
      return panelId === undefined ? undefined : { host: core.client, panelId, ...scoped, page: this.settingsPage('local', core.client, panelId) };
    });
  }

  // What a core panel's settings page shows: its core, the chat's settings folder and the chat (settingsPageChat).
  private settingsPage(authority: string, client: CoreClient, corePanelId: string): SettingsAttachTarget['page'] {
    const entry = client.chat(corePanelId);
    const panel = entry && this.views?.chats().find((chat) => chat.panelId === entry.viewId && chat.authority === authority);
    const folder = entry?.settingsFolder?.path;
    const chat = panel ? settingsPageChat(this.sessionIdOf(panel), panel) : entry?.sessionId ?? `${NEW_CHAT_ID_PREFIX}${entry?.viewId ?? corePanelId}`;
    return { authority, ...(folder !== undefined ? { folder } : {}), chat };
  }

  // The scope tabs the settings show for the selected chat: none for a local chat, and a remote chat's while it closed with
  // its core and reopens selected.
  private settingsScopes(): SettingsScopes | undefined {
    const selected = this.views?.selected();
    const authority = selected ? selected.authority : this.reopeningSelectedAuthority();
    if (authority === undefined || authority === 'local') return undefined;
    const projectKey = selected ? this.projectOf(selected) : this.selectedProjectKey;
    const project = projectKey === undefined ? undefined : this.remoteProject(projectKey);
    const projectFile = project ? pathFor(project).join(project.fsPath, '.damocles', 'settings.json') : undefined;
    const color = this.hostColor(authority);
    const canAllowYolo = this.savedHostRecord(authority) !== undefined;
    return { host: { authority, name: this.hostName(authority), ...(color !== undefined ? { color } : {}), ...(canAllowYolo ? { canAllowYolo } : {}) }, ...(projectFile !== undefined ? { projectFile } : {}) };
  }

  // The authority whose core closed the selected chat, which reopens selected (reselectRemote), while no chat is selected.
  private reopeningSelectedAuthority(): string | undefined {
    const authority = this.selectedProjectKey === undefined ? undefined : authorityKeyOfProject(this.selectedProjectKey);
    return authority !== undefined && this.reselectRemote.has(authority) && !this.views?.selected() ? authority : undefined;
  }

  private settingsHostAway(authority: string): OverlaySettingsAwayState | undefined {
    const pending = this.pendingSwitches.get(authority);
    return hostAwayOf(hostCoreFacts({
      connection: this.authorities?.connection(authority),
      reconnect: this.reconnectPhaseOf(authority)?.phase,
      state: this.authorities?.state(authority) ?? 'offline',
      // only a daemon of another protocol holds the host away; a compatible one's switch is a reconnect
      followed: pending?.following() !== undefined ? pending : undefined,
      core: this.remoteCores.get(authority),
      reopeningSelected: this.reopeningSelectedAuthority() === authority,
    }));
  }

  // Restore default layout: window-layout.json back to its defaults, applied to this window now.
  private resetLayout(): void {
    this.windowLayout.reset();
    this.layoutRevision += 1;
    const window = this.window;
    if (window && !window.isDestroyed()) {
      if (window.isFullScreen()) window.setFullScreen(false);
      if (window.isMaximized()) window.unmaximize();
      const bounds = defaultWindowBounds(screen.getDisplayMatching(window.getBounds()).workArea);
      window.setBounds(bounds);
      if (this.windowBounds) sizeExactly(window, bounds, this.windowBounds);
    }
    this.terminals?.setListWidth(TERMINAL_LIST_DEFAULT_REM);
    this.shellStateChanged();
    this.postTerminalShown();
  }

  // VS Code's onBeforeShutdown saves the window state, and a closing window does not rewrite it (windowsStateHandler.ts).
  private sealPersistedState(window: BrowserWindow, tracker: WindowBoundsTracker): void {
    this.saveWindowPlacement(window, tracker);
    this.heldPrompts.keep();
    this.states.seal();
    this.windowLayout.seal();
    this.remoteState?.seal();
  }

  // Normal bounds, so a maximized window restores to the size it had before it was maximized.
  private saveWindowPlacement(window: BrowserWindow, tracker: WindowBoundsTracker): void {
    if (window.isDestroyed()) return;
    refreshNormalBounds(window, tracker);
    const bounds = boundsToPersist(tracker.applied, tracker.normal);
    this.windowLayout.setWindow({ bounds, maximized: window.isMaximized(), fullScreen: window.isFullScreen() });
  }

  private chatGaveUp(panel: DesktopPanel): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Chat');
    this.notifications.error(t('A chat stopped working because its page kept crashing.'), reload).then((answer) => {
      if (answer !== reload || panel.isDisposed) return;
      // Reload Chat is the user's choice: the reloaded chat takes focus once its page has loaded, when it is still selected,
      // since focus given to a page whose renderer is still starting is lost.
      panel.webContents.once('did-finish-load', () => {
        if (!panel.isDisposed && this.views?.selected() === panel) this.views.focusChat();
      });
      panel.restart();
    }, this.report('Reporting a crashed chat'));
  }

  // The window's own page draws the title bar and sidebar, so the overlay's dialog asks, which falls back to the OS box.
  private shellGaveUp(shell: ShellHost): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Window');
    this.notifications.error(t('The Damocles window stopped working because its page kept crashing.'), { modal: true }, reload).then((answer) => {
      if (answer === reload) shell.restart();
    }, this.report('Reporting a crashed window'));
  }

  // A second launch, a tray click or a macOS dock click: focus the window, or reopen it with its chats when it was closed,
  // which needs a running engine.
  private showWindow(): void {
    // A quit past its last question has closed the window for good.
    const phase = this.lifecycle.phase;
    if (phase === 'disposing' || phase === 'done') return;
    if (!this.window) {
      if (!this.core.current()) return;
      this.createWindow();
      for (const host of [this.core, ...[...this.remoteCores.values()].map((remote) => remote.host)]) host.openTabs().catch(this.report('Reopening chats'));
      return;
    }
    this.revealWindow();
  }

  // VS Code's windowImpl.ts:460 doFocusWindow.
  private revealWindow(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  // Every saved chat loads again; the saved selection, else a saved chat of the saved project, else the first, is shown
  // before any of them loads. With none saved, the saved (else default) project gets a new chat. The shown chat takes
  // keyboard focus once its page is ready, unless the user acted first; a reopened window and a host reload do the same.
  // Only CoreHost calls this, so a reload never disposes the core it reopens the chats into; it runs only once that core is
  // ready (openTabsAtLaunch, the reload path), and creates the views before its first await, so a request a reload held
  // finds them. After a restart each chat gets the permissions the ended core published for it.
  private async openInitialChats(afterRestart: boolean): Promise<void> {
    const core = this.requireCore();
    const views = this.requireViews();
    const kept = this.keptPermissions.reopening(afterRestart);
    const persisted = this.states.list();
    const selection = this.states.selected();
    const savedProject = selection && this.isKnownProject(selection.projectKey, core) ? selection.projectKey : undefined;
    // a remote project selected before this core was ready keeps the selection; its own core opens its chat (coreOpened)
    const selectedElsewhere = this.remoteSelected();
    // A chat of a project whose folder is not there, or not checked yet, keeps its panels.json entry and opens once a check
    // finds the folder.
    this.skippedChats.clear();
    const opening = persisted.filter((saved) => {
      const projectKey = this.savedProjectOf(core, saved);
      if (!this.chatsHeld(projectKey)) return true;
      this.skippedChats.set(saved.panelId, { saved, projectKey });
      return false;
    });
    if (opening.length === 0) {
      const target = this.restoreAtLaunch ? savedProject : undefined;
      if (selectedElsewhere) return;
      if (target !== undefined && this.chatsHeld(target)) this.showAbsentProject(target);
      else await this.newChatIn(core, target, { focus: 'whenReady' });
      return;
    }
    const restored = opening.map((saved) => ({ host: this.createSavedChat(core, views, saved), saved }));
    const selected = restored.find(({ saved }) => saved.panelId === selection?.panelId)
      ?? restored.find(({ host }) => selection?.sessionId !== undefined && host.savedSessionId === selection.sessionId)
      ?? restored.find(({ host }) => this.projectOf(host) === savedProject)
      ?? restored[0];
    if (!selectedElsewhere) {
      if (savedProject !== undefined && this.chatsHeld(savedProject)) this.showAbsentProject(savedProject);
      else if (selected) this.showChat(selected.host, { focus: 'whenReady' });
    }
    const ordered = selected ? [selected, ...restored.filter((entry) => entry !== selected)] : restored;
    // One at a time, each chat's restore recorded before any starts, so a request for a chat still queued waits for it too.
    let previous: Promise<void> = Promise.resolve();
    for (const { host, saved } of ordered) {
      const restore = previous.then(() => this.restoreSavedChat(core, host, saved, kept.get(saved.panelId)));
      this.chatRestores.set(host, restore);
      previous = restore.catch(this.report('Restoring a chat'));
    }
    await previous;
    this.scheduleRetention();
  }

  // A saved chat's view, made before any restore awaits (openInitialChats).
  private createSavedChat(core: ChatCore, views: PanelViews, saved: PersistedChat): DesktopPanel {
    const host = views.create({ options: CHAT_PANEL, restore: { panelId: saved.panelId, state: saved.state } });
    // Tracked under its project, never its working folder: until core binds it, projectOf reads this key.
    this.trackChat(host, this.savedProjectOf(core, saved));
    // A chat whose saved pages are on their way back is active, so retention keeps it until they arrive.
    if (saved.browser.pages.length > 0) this.browserTabs?.setRestoring(host, true);
    if (saved.heldPrompt) this.heldPrompts.restoring(saved.panelId);
    this.lastViewed.set(host, ++this.viewCount);
    return host;
  }

  private async restoreSavedChat(core: DesktopCore, host: DesktopPanel, saved: PersistedChat, permissions?: ChatPermissions): Promise<void> {
    await this.restoreInCore(core, host, host.savedFolderKey, permissions);
    this.restorePages(core, host, saved.browser.pages, saved.browser.activePage);
    if (saved.designTabs) this.designPreviews?.restore(host, saved.designTabs);
    this.restoreHeldPrompt(core, host, saved.heldPrompt);
  }

  // The project a saved chat reopens in: its saved folder's, else the default one, as core sets it up.
  private savedProjectOf(core: ChatCore, saved: PersistedChat): string {
    const folder = restoredWorkspaceFolderKey(saved.state) ?? this.defaultProjectKey(core);
    const listed = (key: string): boolean => this.projectListed(key);
    return savedChatProjectKey(folder, {
      listed,
      records: this.worktreeRecords.records(),
      keyOf: folderKey,
      movedFrom: (key) => this.movedFrom(key),
      resolve: (key) => chatProjectKey(key, core.client, listed) ?? key,
    });
  }

  // The listed project a finished move left for this key, while its host part has not changed the list yet.
  private movedFrom(key: string): string | undefined {
    const from = this.movedProjects.get(key);
    return from !== undefined && this.projectListed(from) ? from : undefined;
  }

  // The skipped saved chats of a project whose folder is back open, after the chats already open. During a reload, which
  // closes them first, the reload's own reopen opens them.
  private reopenSkippedChats(projectKey: string): void {
    const core = this.core.current();
    const views = this.views;
    const reopening = [...this.skippedChats.values()].filter((skipped) => skipped.projectKey === projectKey);
    if (!core || !views || reopening.length === 0) return;
    let previous: Promise<void> = Promise.resolve();
    for (const { saved } of reopening) {
      this.skippedChats.delete(saved.panelId);
      const host = this.createSavedChat(core, views, saved);
      const restore = previous.then(() => this.restoreSavedChat(core, host, saved));
      this.chatRestores.set(host, restore);
      previous = restore.catch(this.report('Restoring a chat'));
    }
    void previous.then(() => this.scheduleRetention());
  }

  // A project that left the list takes its skipped chats' panels.json entries with it, which would reopen in another folder;
  // a moved project's chats, re-keyed before its list change, stay.
  private dropSkippedChatsOfUnlisted(): void {
    for (const [panelId, { projectKey }] of this.skippedChats) {
      if (this.projectListed(projectKey) || this.movedFrom(projectKey) !== undefined) continue;
      this.skippedChats.delete(panelId);
      this.states.delete(panelId);
    }
  }

  // A remote project that left the list takes its skipped chats' remote-state.json records with it, which would reopen on its
  // host in a folder that is gone; a moved project's chats stay, as relocateStores re-keys them and records the move in
  // movedProjects before replaceProject changes the list.
  private dropSkippedRemoteChatsOfUnlisted(): void {
    const changed = new Set<string>();
    for (const [panelToken, { authority, projectKey }] of [...this.skippedRemoteChats]) {
      if (this.projectListed(projectKey) || this.movedFrom(projectKey) !== undefined) continue;
      this.skippedRemoteChats.delete(panelToken);
      changed.add(authority);
    }
    for (const authority of changed) this.saveRemoteChats(authority);
  }

  private async restoreInCore(core: ChatCore, chat: DesktopPanel, folderKey: string | undefined, permissions?: ChatPermissions): Promise<void> {
    await this.beforeChatRestore();
    // A chat closed meanwhile (dropped while an earlier one loaded, or by the quit) is gone; setting up a session for it would leak one.
    if (chat.isDisposed) return;
    await core.client.restoreChat(chat, folderKey, permissions);
  }

  // Every chat main creates outside openInitialChats is restored here, so a request for it can wait until core registered it.
  private restoreChat(core: ChatCore, chat: DesktopPanel, folderKey: string | undefined): Promise<void> {
    const restore = this.restoreInCore(core, chat, folderKey);
    this.chatRestores.set(chat, restore);
    return restore;
  }

  // The chat's core panel id once core finished restoring it; failed when core restored it without registering it.
  private async restoredCorePanel(chat: DesktopPanel): Promise<{ readonly corePanelId: string | undefined; readonly failed: boolean }> {
    const restore = this.chatRestores.get(chat);
    await restore?.catch(() => undefined);
    const corePanelId = this.corePanelIdOf(chat);
    return { corePanelId, failed: corePanelId === undefined && restore !== undefined && !chat.isDisposed };
  }

  // A prompt the chat held for its worktree when the window closed goes back into its composer, once.
  private restoreHeldPrompt(core: DesktopCore, chat: DesktopPanel, held: readonly UserContentBlock[] | undefined): void {
    const corePanelId = this.corePanelIdOf(chat);
    if (!held || corePanelId === undefined) return;
    core.client.restoreDraft(corePanelId, held).then(
      () => this.heldPrompts.restored(chat.panelId),
      this.report('Putting a held prompt back in its composer'),
    );
  }

  // Reopens a chat's saved pages as its tabs once the browser relaunches, which the remaining chats and the updater do not
  // wait for; the active editor tab stays as restored meanwhile and no page takes focus.
  private restorePages(core: DesktopCore, chat: DesktopPanel, urls: readonly string[], activePage: number | undefined): void {
    // A chat the quit closed while core restored it has no tabs left to restore into.
    if (urls.length === 0 || chat.isDisposed) return;
    const browserTabs = this.browserTabs;
    if (this.e2ePageRestores) this.e2ePageRestores.count += 1;
    core.client.restorePages(chat.panelId, urls, activePage)
      .catch(this.report('Restoring browser pages'))
      .finally(() => browserTabs?.setRestoring(chat, false));
  }

  // Every chat main or core creates passes through here once, before it is shown.
  private trackChat(panel: DesktopPanel, projectKey: string): void {
    this.openedInProject.set(panel, projectKey);
    panel.onDispose(() => this.chatClosed(panel));
  }

  // A chat core opens itself (Open Chat, a fork, a dialog with no chat loaded) lands in the selected project,
  // which core uses as its default folder.
  private openCoreChat(options: PanelOptions, panelId: string, authority: string): DesktopPanel {
    const core = this.requireChatCore(authority);
    const views = this.requireViews();
    const { parent, ...viewOptions } = options;
    const host = views.create({ options: viewOptions, panelId, ...(authority !== 'local' ? { authority } : {}) });
    const parentChat = parent ? views.chats().find((chat) => chat === parent) : undefined;
    if (parentChat) this.designParents.set(host, parentChat);
    // core opens it in its default folder, its own project's, while a project of another authority is selected; a design
    // chat opens in its parent's
    const selected = this.selectedProjectKey;
    const parentProject = parentChat ? this.projectOf(parentChat) : undefined;
    this.trackChat(host, parentProject ?? (selected !== undefined && authorityKeyOfProject(selected) === authority ? selected : this.defaultProjectKey(core)));
    // Core sets the chat up once this returns; a mention or Add to Chat waits for that as for a chat main restores.
    this.chatRestores.set(host, this.beforeChatRestore().then(() => core.client.whenSetUp(host.panelId)));
    if (!this.settingsOpening.hold(host, authority === 'local')) this.showChat(host, { focus: true });
    return host;
  }

  // worktree: the New menu's opt-in (D30), checked against fresh options; plain New Chat and Ctrl+N never pass one
  private newChat(projectKey: string | undefined, worktree?: NewChatWorktree): Promise<void> {
    const authority = authorityKeyOfProject(projectKey ?? this.selectedProjectKey ?? '');
    return this.chatHost(authority).run('New Chat', (core) => this.newChatIn(core, projectKey, { focus: true }, worktree));
  }

  private async newChatIn(core: ChatCore, projectKey: string | undefined, options: { readonly focus: ShowFocus } = { focus: true }, worktree?: NewChatWorktree): Promise<void> {
    const views = this.requireViews();
    const selected = this.selectedProjectKey !== undefined && authorityKeyOfProject(this.selectedProjectKey) === core.authority ? this.selectedProjectKey : undefined;
    const key = projectKey ?? selected ?? this.defaultProjectKey(core);
    if (!this.isKnownProject(key, core)) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    if (this.projectAbsent(key)) {
      this.showAbsentProject(key);
      return;
    }
    if (worktree && !(await this.worktreesOf(core.authority).checkOptIn(this.worktreeProject(key), worktree.startRef, worktree.bringChanges))) {
      throw new Error(this.requireLocalization().t('The worktree options changed. Open the New menu again.'));
    }
    const host = views.create({ options: CHAT_PANEL, ...(core.authority !== 'local' ? { authority: core.authority } : {}) });
    this.trackChat(host, key);
    if (!worktree) {
      this.showChat(host, options);
      await this.restoreChat(core, host, key);
      return;
    }
    // The chat shows only once core holds the opt-in, so its first send can never reach the project folder; until then
    // retention leaves it alone.
    this.openingInWorktree.add(host);
    try {
      await this.restoreChat(core, host, key);
      const corePanelId = this.corePanelIdOf(host);
      if (corePanelId === undefined) throw new Error(this.requireLocalization().t('The chat closed before it could use a worktree.'));
      await core.client.setWorktreeOptIn(corePanelId, worktree.startRef, worktree.bringChanges);
    } catch (err) {
      if (!host.isDisposed) host.close();
      throw err;
    } finally {
      this.openingInWorktree.delete(host);
    }
    this.showChat(host, options);
  }

  // Core binds the new chat to the worktree before its first session exists, and it shows only once bound.
  private async newChatInWorktree(target: NewChatInWorktreeRequest | undefined): Promise<void> {
    const { t } = this.requireLocalization();
    const request = target ?? this.menuState().newChatInWorktree;
    if (!request) throw new Error(t('The selected chat does not work in a worktree.'));
    const authority = authorityKeyOfProject(request.projectKey);
    if (this.refusesMirrored(authority)) return;
    await this.chatHost(authority).run('New Chat in This Worktree', async (core) => {
      const live = this.newChatInTarget(this.worktreeRegistry(authority)?.get(request.worktreeId));
      if (live?.projectKey !== request.projectKey) throw new Error(t('The worktree is no longer a worktree of this project.'));
      const host = this.requireViews().create({ options: CHAT_PANEL, ...(authority !== 'local' ? { authority } : {}) });
      this.trackChat(host, request.projectKey);
      this.openingInWorktree.add(host);
      const started = this.beforeChatRestore().then(async () => {
        if (host.isDisposed) throw new Error(t('The chat closed before it could use a worktree.'));
        await core.client.startInWorktree(host, request.projectKey, request.worktreeId);
      });
      this.chatRestores.set(host, started);
      try {
        await started;
      } catch (err) {
        if (!host.isDisposed) host.close();
        throw err;
      } finally {
        this.openingInWorktree.delete(host);
      }
      this.showChat(host, { focus: true });
    });
  }

  private newChatInWorktreeFailure(): (err: unknown) => void {
    return this.shellFailure('New Chat in This Worktree', 'Damocles could not open a new conversation: {0}');
  }

  private worktreeOptions(projectKey: string): Promise<ChatsWorktreeOptions> {
    return this.worktreesOf(authorityKeyOfProject(projectKey)).options(this.worktreeProject(projectKey));
  }

  // A project the New menu or a worktree flow names: a local one of the list, or a remote one of its host.
  private worktreeProject(key: string): { fsPath: string; name: string } {
    if (authorityKeyOfProject(key) === 'local') return this.projectByKey(key);
    const project = this.remoteProject(key);
    if (!project) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    return project;
  }

  private showFolder(request: ShowFolderRequest): void {
    this.projectByKey(request.projectKey);
    this.shownFolders.show(request.projectKey, request.show);
  }

  // A worktree main lists for the project, never one another project or a renderer names by path.
  private async worktreeFinish(request: WorktreeFinishRequest): Promise<void> {
    if (this.refusesMirrored(authorityKeyOfProject(request.projectKey))) return;
    const root = this.roots.resolve(rootKey({ projectKey: request.projectKey, worktreeId: request.worktreeId }));
    if (!root?.worktree) {
      void this.notifications.info(this.requireLocalization().t('This worktree no longer exists.'));
      return;
    }
    await this.worktreesOf(authorityKeyOfProject(request.projectKey)).finish(request.worktreeId, request.action);
  }

  private async addProject(): Promise<void> {
    const platform = this.requirePlatform();
    const folder = await platform.nativeDialogs.pickFolder({ title: platform.localization.t('Add Project') });
    if (folder === undefined) return;
    await this.addProjectAt(folder);
  }

  // The trust question comes first, so core's match reads the folder's root commits; the folder joins the project list, trusted
  // or not, then a chat opens there, unless the user moves a missing project's chats here (project-readd.ts).
  private async addProjectAt(folder: string): Promise<void> {
    const { t } = this.requireLocalization();
    const outcome = await addProjectAt(folder, {
      // the grant reaches core's trust mirror ahead of projects.movedFrom, on the same ordered channel
      askTrust: (added) => this.trust.askTrust(added),
      candidates: (added) => this.missingProjectsOf(added),
      confirm: (question) => this.askLocateConfirm(question),
      pick: (placeholder, items) => this.pickMissingProject(placeholder, items),
      add: async (added) => {
        await this.projects.add(added);
      },
      moveChats: (key, added) => this.locateProject(key, added),
      newChat: (added) => this.newChat(folderKey(added)),
      joinQuit: (work) => this.quitJoins.join(work),
      t: (message, ...args) => t(message, ...args),
    });
    log(`[projects] Add Project of ${folder}: ${outcome}`);
  }

  private async pickMissingProject(placeholder: string, items: readonly OverlayQuickPickItem[]): Promise<string | undefined> {
    const overlay = this.overlay;
    if (!overlay) throw new Error('The Add Project question has no window to show in');
    this.revealWindow();
    const answer = await overlay.request({ kind: 'quickPick', placeholder, items }, this.window?.webContents);
    return answer.kind === 'quickPick' ? answer.itemId : undefined;
  }

  // The listed local projects whose folder is missing and whose chats core says the folder may take over; a failed lookup offers none.
  private async missingProjectsOf(folder: string): Promise<MissingProject[]> {
    const candidates = await this.core.run('Add Project', (core) => core.client.movedFrom(folder)).catch((err: unknown) => {
      log(`[projects] looking for missing projects of ${folder} failed: ${errorText(err)}`);
      return [];
    });
    return candidates.flatMap((candidate) => {
      const key = folderKey(candidate.from);
      return this.listedFolder(key) ? [{ key, name: this.localProjectName(key), fsPath: candidate.from, chats: candidate.chats }] : [];
    });
  }

  // Keys from the shell are matched against the project list; a renderer string is never used as a path.
  private projectByKey(key: string): { fsPath: string; name: string } {
    const project = this.listedFolder(key);
    if (!project) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    return project;
  }

  // A project of the list, or the folder chats open in while the list is empty.
  private isKnownProject(key: string, core: ChatCore): boolean {
    if (authorityKeyOfProject(key) !== core.authority) return false;
    const listed = core.authority === 'local' ? this.projects.folders().some((folder) => folderKey(folder.fsPath) === key) : this.remoteProject(key) !== undefined;
    return listed || core.client.defaultTarget()?.key === key;
  }

  // The folder chats open in when none is named; core publishes its folder targets as it starts.
  private defaultProjectKey(core: ChatCore): string {
    const key = core.client.defaultTarget()?.key;
    if (key === undefined) throw new Error('Damocles Core has not reported its folders yet');
    return key;
  }

  // The chat's core panel id on its own core once that core registered it.
  private corePanelIdOf(panel: DesktopPanel): string | undefined {
    return this.clientOf(panel)?.chatOfView(panel.panelId)?.panelId;
  }

  // The key main's per-chat maps (activity, worktree states, notifications, reviews) name the chat by.
  private chatKeyOf(panel: DesktopPanel): string | undefined {
    const corePanelId = this.corePanelIdOf(panel);
    return corePanelId === undefined ? undefined : chatKey(panel.authority, corePanelId);
  }

  private panelOfCore(key: string): DesktopPanel | undefined {
    const { authority, corePanelId } = parseChatKey(key);
    const viewId = this.clientFor(authority)?.chat(corePanelId)?.viewId;
    return viewId === undefined ? undefined : this.views?.chats().find((chat) => chat.panelId === viewId && chat.authority === authority);
  }

  private boundSessionIdOf(panel: DesktopPanel): string | undefined {
    return this.clientOf(panel)?.chatOfView(panel.panelId)?.sessionId;
  }

  // The session a restore its lease refused opens once the lease turns stale (a crashed core's, after a restart).
  private restoreRetryOf(panel: DesktopPanel): string | undefined {
    return this.clientOf(panel)?.chatOfView(panel.panelId)?.restoring;
  }

  // The running client of the chat's core; undefined while that core is not ready.
  private clientOf(panel: DesktopPanel): CoreClient | undefined {
    return this.clientFor(panel.authority);
  }

  private clientFor(authority: string): CoreClient | undefined {
    return authority === 'local' ? this.client() : this.remoteCores.get(authority)?.host.current()?.client;
  }

  // The core host of an authority; a remote one that never connected has none.
  private chatHost(authority: string): ChatCoreHost {
    if (authority === 'local') return this.core;
    const remote = this.remoteCores.get(authority);
    if (!remote) throw this.notConnected(authority);
    return remote.host;
  }

  private requireChatCore(authority: string): ChatCore {
    const core = this.chatHost(authority).current();
    if (!core) throw new Error('Core services used before startup finished or while they reload');
    return core;
  }

  // A core's chats closed with it: their activity, notifications and reviews go.
  private forgetChatsOf(authority: string): void {
    for (const key of [...this.activity.keys()]) {
      if (parseChatKey(key).authority !== authority) continue;
      this.activity.delete(key);
      this.notificationCenter.panelClosed(key);
      void this.chatReviews.panelClosed(key).catch(this.report('Closing a chat review'));
    }
    for (const key of [...this.worktreeStates.keys()]) if (parseChatKey(key).authority === authority) this.worktreeStates.delete(key);
  }

  // The chat's stored session: the one core bound, else, while it restores, the one a lease retry or its saved state names.
  private sessionIdOf(panel: DesktopPanel): string | undefined {
    return this.boundSessionIdOf(panel) ?? this.restoreRetryOf(panel) ?? panel.savedSessionId;
  }

  // Core binds a restored chat's saved session only in its webview's `ready`, well after it registers the chat, and a
  // refused restore only once its retry runs.
  private isRestoring(panel: DesktopPanel): boolean {
    return this.boundSessionIdOf(panel) === undefined && (this.restoreRetryOf(panel) !== undefined || panel.savedSessionId !== undefined);
  }

  private activityOf(panel: DesktopPanel): ChatActivity | undefined {
    const key = this.chatKeyOf(panel);
    return key === undefined ? undefined : this.activity.get(key);
  }

  // A chat core has registered that has no conversation and no session file, bound or being restored.
  private isEmpty(panel: DesktopPanel): boolean {
    const chat = this.clientOf(panel)?.chatOfView(panel.panelId);
    if (!chat) return false;
    return !chat.hasConversation && this.sessionIdOf(panel) === undefined;
  }

  private chatIdOf(panel: DesktopPanel): string {
    return this.sessionIdOf(panel) ?? `${NEW_CHAT_ID_PREFIX}${panel.panelId}`;
  }

  // The project a chat belongs to: the owner core named for its working folder, else its folder's (docs/invariants.md
  // "Worktree chats", Ownership); it lists there, and Remove Project, a relocation and the busy checks take it with that project.
  private projectOf(panel: DesktopPanel): string | undefined {
    const client = this.clientOf(panel);
    const opened = this.openedInProject.get(panel);
    if (!client) return opened;
    const folder = client.chatOfView(panel.panelId)?.folder ?? opened;
    if (folder === undefined) return undefined;
    const listed = panel.authority === 'local'
      ? (candidate: string) => this.projects.folders().some((each) => folderKey(each.fsPath) === candidate)
      : (candidate: string) => this.remoteProject(candidate) !== undefined;
    return chatProjectKey(folder, client, listed);
  }

  private loadedChat(chatId: string): DesktopPanel | undefined {
    const views = this.views;
    if (!views) return undefined;
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) {
      const panel = views.panel(chatId.slice(NEW_CHAT_ID_PREFIX.length));
      return panel && views.chats().includes(panel) ? panel : undefined;
    }
    return views.chats().find((chat) => this.sessionIdOf(chat) === chatId);
  }

  // The stored session with this id in the project's catalog, else in any other project's.
  private async storedChat(core: ChatCore, sessionId: string): Promise<{ readonly session: StoredSession; readonly projectKey: string } | undefined> {
    const listed = core.authority === 'local'
      ? this.projects.folders().map((folder) => folderKey(folder.fsPath))
      : this.remoteProjects().filter((project) => project.authorityKey === core.authority).map((project) => project.key);
    const keys = [...new Set([this.selectedProjectKey, ...listed])].filter((key) => key === undefined || authorityKeyOfProject(key) === core.authority);
    // The shown lists first, which hold a clicked row; only a miss waits for the rows still being parsed.
    for (const read of [(key: string) => core.client.listSessions(key), (key: string) => core.client.listSessions(key, true)]) {
      for (const key of keys) {
        if (key === undefined) continue;
        const session = (await read(key)).find((row) => row.id === sessionId);
        if (session) return { session, projectKey: key };
      }
    }
    return undefined;
  }

  private async catalogList(core: ChatCore, projectKey: string): Promise<readonly StoredSession[]> {
    const rows = await core.client.listSessions(projectKey);
    this.catalogRows.set(projectKey, rows);
    return rows;
  }

  private refreshSelectedCatalog(): void {
    const key = this.selectedProjectKey;
    if (key === undefined || this.catalogRows.has(key)) return;
    const authority = authorityKeyOfProject(key);
    const read = this.mirrorListed(authority)
      ? this.mirroredRows(key, '')
      : this.clientFor(authority) ? this.chatHost(authority).read('Read Chat List', (core) => this.catalogList(core, key)) : undefined;
    read?.then(() => this.shellStateChanged(), this.report('Reading the chat list'));
  }

  private showChat(panel: DesktopPanel, options: { readonly focus: ShowFocus }): void {
    const views = this.views;
    if (!views || panel.isDisposed) return;
    const chatId = this.chatIdOf(panel);
    const projectKey = this.projectOf(panel);
    if (this.unloads.defer(panel, () => this.showAfterUnload(panel, chatId, projectKey, options))) return;
    views.show(panel.panelId, options);
    this.lastViewed.set(panel, ++this.viewCount);
    this.selectionChanged(panel);
    this.scheduleRetention();
  }

  // Core answered the unload a show waited for: the chat it kept shows, one it closed opens again from its session file.
  private showAfterUnload(panel: DesktopPanel, chatId: string, projectKey: string | undefined, options: { readonly focus: ShowFocus }): void {
    if (!panel.isDisposed) {
      this.showChat(panel, options);
      return;
    }
    if (!chatId.startsWith(NEW_CHAT_ID_PREFIX)) this.selectChat(chatId, panel.authority).catch(this.report('Selecting a chat core unloaded'));
    else if (projectKey !== undefined) this.selectProject(projectKey, false).catch(this.report('Selecting the project of a chat core unloaded'));
  }

  // Records the selected chat's project, its place in the project memory and panels.json.
  private selectionChanged(panel: DesktopPanel): void {
    const projectKey = this.projectOf(panel);
    // a remote chat of a project removed meanwhile stays open until its host lets it go, and never selects that project again
    if (projectKey === undefined || (authorityKeyOfProject(projectKey) !== 'local' && !this.remoteProject(projectKey))) return;
    const projectChanged = projectKey !== this.selectedProjectKey;
    this.selectedProjectKey = projectKey;
    if (projectChanged) {
      this.search?.stopAll();
      this.scm?.selectedProjectChanged();
      // the New Terminal dropdown lists the selected project's host's shells
      this.terminals?.publish();
    }
    const sessionId = this.sessionIdOf(panel);
    recordSelection(
      { states: this.states, remoteState: this.remoteState, lastChats: this.lastChats, report: this.report('Saving the remote selection') },
      { projectKey, chatId: this.chatIdOf(panel), panelId: panel.panelId, authority: panel.authority, ...(sessionId !== undefined ? { sessionId } : {}) },
    );
    const client = this.clientOf(panel);
    if (projectChanged && client && client.defaultTarget()?.key !== projectKey) {
      client.setDefaultFolder(projectKey).catch(this.report('Following the selected project'));
    }
    this.refreshSelectedCatalog();
    this.shownFolders.refresh();
    this.chatsChanged(projectKey);
    this.shellStateChanged();
    const viewed = this.viewedChat();
    if (viewed) this.notificationCenter.chatViewed(viewed);
  }

  // authority: the core that named the chat, for a chat id that may not be loaded
  private async selectChat(chatId: string, authority: string = this.chatAuthority(chatId)): Promise<SelectChatResult> {
    // a project selection still checking its folder no longer selects
    const turn = this.selectionTurns.begin();
    try {
      // a loaded chat of a host with no connection is its transcript, which needs no core of that host
      if (this.mirrorListed(authority)) return await this.openMirroredChat(authority, chatId);
      return await this.chatHost(authority).run('Select Chat', (core) => this.selectChatIn(core, chatId));
    } finally {
      turn.settle();
    }
  }

  // A host connecting or offline: its projects' chats are the session mirror's, read-only.
  private mirrorListed(authority: string): boolean {
    return this.savedHostIdOf(authority) !== undefined && this.authorities?.connection(authority) === undefined;
  }

  // A chat of the offline chat list opens as its mirrored transcript; once the host connected meanwhile, its live chat opens.
  private async openMirroredChat(authority: string, sessionId: string): Promise<SelectChatResult> {
    const opened = await this.chatWork.run(sessionId, async (): Promise<SelectChatResult | undefined> => {
      const view = this.loadedChat(sessionId) ?? (await this.transcripts.openChat(authority, sessionId));
      if (!view) return undefined;
      this.showChat(view, { focus: true });
      return { ok: true };
    });
    if (opened) return opened;
    // outside the chat's work queue, which the live selection takes itself
    if (!this.mirrorListed(authority)) return this.chatHost(authority).run('Select Chat', (core) => this.selectChatIn(core, sessionId));
    log(`[chats] the mirror of ${authority} holds no chat ${sessionId}`);
    return this.missingChat();
  }

  // A remote project's chats while its host is connecting or offline: the session mirror's, read by this computer's core.
  private async mirroredChats(projectKey: string, query: string, withNewChats: boolean): Promise<ShellChatList | undefined> {
    const rows = await this.mirroredRows(projectKey, query);
    return rows === undefined ? undefined : this.chatList(projectKey, rows, withNewChats);
  }

  private async mirroredRows(projectKey: string, query: string): Promise<readonly StoredSession[] | undefined> {
    const project = this.remoteProject(projectKey);
    const hostId = project === undefined ? undefined : this.savedHostIdOf(project.authorityKey);
    if (!project || hostId === undefined) return undefined;
    const folder = this.sessionMirrorOf(hostId).projectFolder(project.folderKey);
    const os = this.knownAuthorityOs(project.authorityKey);
    const mirrorOs = os === undefined ? undefined : os === 'win32' || os === 'darwin' ? os : 'linux';
    const rows = await this.core.read('List Mirrored Chats', (core) => core.client.listMirroredSessions(hostId, folder, query, mirrorOs, project.fsPath));
    // the title bar names a transcript by its row, until the host's own catalog lists the project
    if (query === '' && this.mirrorListed(project.authorityKey)) this.catalogRows.set(projectKey, rows);
    return rows;
  }

  // The core a chat id names a chat of: a loaded chat's own, else the selected project's, whose list the shell shows.
  private chatAuthority(chatId: string): string {
    const loaded = this.loadedChat(chatId);
    if (loaded) return loaded.authority;
    return this.selectedProjectKey === undefined ? 'local' : authorityKeyOfProject(this.selectedProjectKey);
  }

  // chats.showSession: the core revealed a chat as this device's work, so it shows here, joining the panel another device
  // shows; rejects when it did not open, which the daemon answers core as not shown
  private async showSessionOf(authority: string, sessionId: string): Promise<void> {
    const shown = await this.chatHost(authority).run('Show Chat', (core) => (core.rejoin ? this.showHeldChatIn(core, core.rejoin, sessionId) : this.selectChatIn(core, sessionId).then((result) => result.ok)));
    if (!shown) throw new Error(`Chat ${sessionId} of ${authority} did not open on this device`);
  }

  private showHeldChatIn(core: ChatCore, rejoin: NonNullable<ChatCore['rejoin']>, sessionId: string): Promise<boolean> {
    const views = this.requireViews();
    return this.chatWork.run(sessionId, () => showHeldChat<DesktopPanel>({
      loaded: () => {
        const loaded = this.loadedChat(sessionId);
        return loaded?.authority === core.authority ? loaded : undefined;
      },
      create: () => {
        const host = views.create({ options: CHAT_PANEL, restore: { panelId: randomUUID(), state: { sessionId } }, authority: core.authority });
        // the joined chat's own folder (its chats mirror entry) names its project once it joined
        const selected = this.selectedProjectKey;
        this.trackChat(host, selected !== undefined && authorityKeyOfProject(selected) === core.authority ? selected : this.defaultProjectKey(core));
        return host;
      },
      join: (host) => {
        const joined = rejoin(host, undefined, sessionId);
        this.chatRestores.set(host, joined.then(() => undefined, () => undefined));
        return joined;
      },
      show: (host) => this.showChat(host, { focus: true }),
      dispose: (host) => host.close(),
    }));
  }

  private async selectChatIn(core: ChatCore, chatId: string): Promise<SelectChatResult> {
    const loaded = this.loadedChat(chatId);
    if (loaded) {
      this.showChat(loaded, { focus: true });
      return { ok: true };
    }
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.missingChat();
    return this.chatWork.run(chatId, async () => {
      const again = this.loadedChat(chatId);
      if (again) {
        this.showChat(again, { focus: true });
        return { ok: true };
      }
      const stored = await this.storedChat(core, chatId);
      if (!stored) {
        log(`[chats] the chat lists of ${core.authority} hold no chat ${chatId}`);
        return this.missingChat();
      }
      if (this.chatsHeld(stored.projectKey)) {
        this.showAbsentProject(stored.projectKey);
        return { ok: true };
      }
      // A local chat holding the conversation shows; another Damocles process's leaves the selection where it is, and core offers a takeover.
      if (await core.client.leaseRefused(chatId, true)) return { ok: false, reason: 'leased' };
      const views = this.requireViews();
      const workspaceFolderKey = core.client.keys.toCore(stored.projectKey);
      const host = views.create({ options: CHAT_PANEL, restore: { panelId: randomUUID(), state: { sessionId: chatId, workspaceFolderKey } }, ...(core.authority !== 'local' ? { authority: core.authority } : {}) });
      this.trackChat(host, stored.projectKey);
      this.showChat(host, { focus: true });
      // a conversation another device has open on the host: this view joins its panel, which stays the one writer
      if (core.rejoin) {
        const rejoin = core.rejoin;
        const joined = (async () => {
          if (await rejoin(host, undefined, chatId)) return;
          if (!host.isDisposed) await core.client.restoreRelayed(host.panelId);
        })();
        this.chatRestores.set(host, joined);
        await joined;
        return { ok: true };
      }
      await this.restoreChat(core, host, stored.projectKey);
      return { ok: true };
    });
  }

  private missingChat(): { ok: false; reason: 'missing' } {
    void this.notifications.info(this.requireLocalization().t('This chat no longer exists.'));
    return { ok: false, reason: 'missing' };
  }

  // The project's last viewed chat while it exists, once it is gone the top of its Chats list, else a new chat; never viewed: a new chat.
  // userStarted: the user picked the project, so a remote one's host connects as the user's connect, which installs the server
  // where Remove Damocles server ran; a selection that follows another action never does
  private async selectProject(key: string, userStarted: boolean): Promise<void> {
    const turn = this.selectionTurns.begin();
    try {
      await this.selectProjectWhile(key, turn.current, userStarted);
    } finally {
      turn.settle();
    }
  }

  // current: whether no later selection overtook this one; userStarted: the user selected it, so its host connects as the user's
  private async selectProjectWhile(key: string, current: () => boolean, userStarted: boolean): Promise<void> {
    if (authorityKeyOfProject(key) !== 'local') {
      const project = this.remoteProject(key);
      if (project) await this.remotePresences.check([{ key, fsPath: project.fsPath }]);
      if (!current()) return;
      if (this.remotePresences.absent(key)) {
        this.showAbsentProject(key);
        return;
      }
      return this.remoteSelection.select(key, userStarted);
    }
    const folder = this.listedFolder(key);
    if (folder) {
      const checked = { key, fsPath: folder.fsPath };
      await checkWhenAdmitted(async () => {
        await this.presences.check([checked]);
        return this.presences.of(key);
      }, this.presenceProbe);
    }
    if (!current()) return;
    // a project whose folder is not there, or not checked yet, shows its placeholder, and core opens none of its chats
    if (this.chatsHeld(key)) {
      this.showAbsentProject(key);
      return;
    }
    return this.core.run('Select Project', (core) => this.selectProjectIn(core, key));
  }

  private localProjects(): CheckedProject[] {
    return this.projects.folders().map((folder) => ({ key: folderKey(folder.fsPath), fsPath: folder.fsPath }));
  }

  // the listed remote projects, or one authority's
  private checkedRemoteProjects(authorityKey?: string): CheckedProject[] {
    return this.remoteProjects().filter((project) => authorityKey === undefined || project.authorityKey === authorityKey).map(({ key, fsPath }) => ({ key, fsPath }));
  }

  // whether the project's folder is not there, by its authority's presence
  private projectAbsent(key: string): boolean {
    return authorityKeyOfProject(key) === 'local' ? this.presences.absent(key) : this.remotePresences.absent(key);
  }

  private presenceOf(key: string): ProjectPresence {
    return authorityKeyOfProject(key) === 'local' ? this.presences.of(key) : this.remotePresences.of(key);
  }

  // Whether the project's chats stay closed: its folder is not there, or no check of it ran yet (the hung gate refused them).
  private chatsHeld(key: string): boolean {
    return this.presenceOf(key) !== 'present';
  }

  // On window focus. A stat of a WSL folder starts its distro, so a WSL project last found present is checked only when selected.
  private async recheckProjectFolders(): Promise<void> {
    await this.selectIfCameBack(await this.presences.check(this.localProjects().filter((project) => this.checkedUnselected(project))));
  }

  // Whether a check that no selection asked for checks the project: a WSL project only while it is not present.
  private checkedUnselected(project: CheckedProject): boolean {
    return this.presences.absent(project.key) || process.platform !== 'win32' || !wslUncToLinux(project.fsPath);
  }

  // A check that gave up on a slow stat (a WSL distro starting) checks its project once more when that stat answered.
  private folderAnsweredLate(folder: string): void {
    const project = this.localProjects().find((candidate) => candidate.fsPath === folder);
    if (project) this.presences.answeredLate(project).then((cameBack) => this.selectIfCameBack(cameBack)).catch(this.report('Checking a project folder again'));
  }

  // The projects whose check the hung gate refused are checked once it admits again.
  private folderChecksAdmitted(): void {
    this.presences.admitted(this.localProjects()).then((cameBack) => this.selectIfCameBack(cameBack)).catch(this.report('Checking the project folders again'));
  }

  // A selection in flight checks its own project; one that starts meanwhile overtakes this.
  private async selectIfCameBack(cameBack: readonly string[]): Promise<void> {
    const key = this.selectedProjectKey;
    const current = this.selectionTurns.join();
    if (key !== undefined && current && cameBack.includes(key)) await this.selectProjectWhile(key, current, false);
  }

  private presenceChanged(key: string, presence: FolderPresence, previous: ProjectPresence): void {
    log(`[projects] the folder of ${key} is ${presence}, was ${previous}`);
    if (presence !== 'present') this.scmClient?.folderChecked(key, presence);
    // a refusal says why a missing folder was not located, so it ends once the folder is back
    if (presence === 'present') this.locateRefusals.delete(key);
    if (presence === 'present' && authorityKeyOfProject(key) !== 'local') this.reopenSkippedRemoteChats(key);
    else if (presence === 'present') this.reopenSkippedChats(key);
    else if (authorityKeyOfProject(key) !== 'local') this.remoteRelocationsFrom(authorityKeyOfProject(key)).catch(this.report('Looking for moved projects'));
    else {
      // the launch asks for its own moves before its chats reopen
      void this.launchTabs.then(() => {
        const core = this.core.started();
        return core?.isReady() ? this.localRelocationsReached(core) : undefined;
      }).catch(this.report('Looking for moved projects'));
    }
    this.shellStateChanged();
    this.refreshMenuState();
  }

  private localTrustChanged(): void {
    this.shownFolders.refresh();
    this.htmlPreviews?.trustChanged();
    this.servedRoots.trustChanged();
    this.shellStateChanged();
  }

  // A project whose folder is not there is selected with no chat of it on screen: the chat view keeps the chat it showed,
  // withheld, and the shell shows the project's placeholder.
  private showAbsentProject(key: string): void {
    if (key !== this.selectedProjectKey) {
      this.selectedProjectKey = key;
      this.search?.stopAll();
      this.scm?.selectedProjectChanged();
      this.terminals?.publish();
    }
    recordProjectSelection({ states: this.states, remoteState: this.remoteState, report: this.report('Saving the remote selection') }, key);
    this.refreshSelectedCatalog();
    this.shownFolders.refresh();
    this.chatsChanged(key);
    this.refreshMenuState();
    this.shellStateChanged();
  }

  // The selected project's chats are held (chatsHeld) and the chat is another project's, kept on screen behind its placeholder.
  private keptBesideAbsentProject(chat: DesktopPanel): boolean {
    const key = this.selectedProjectKey;
    return key !== undefined && this.chatsHeld(key) && this.projectOf(chat) !== key;
  }

  // The shown chat while it is the selected project's to show: neither another authority's chat kept while a remote project's
  // core opens its chats, nor one kept behind the placeholder of a project whose folder is not there.
  private selectedProjectChat(chat: DesktopPanel | undefined): DesktopPanel | undefined {
    const shown = chatOfSelectedProject(this.selectedProjectKey, chat);
    return shown && this.keptBesideAbsentProject(shown) ? undefined : shown;
  }

  private remoteSelected(): boolean {
    return this.selectedProjectKey !== undefined && authorityKeyOfProject(this.selectedProjectKey) !== 'local';
  }

  private async selectProjectIn(core: ChatCore, key: string): Promise<void> {
    if (!this.isKnownProject(key, core)) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    // a remote core opens the selected project's chat once it attached, by when its folder may read missing
    if (this.chatsHeld(key)) {
      this.showAbsentProject(key);
      return;
    }
    await openProjectChat({
      remembered: this.lastChats.remembered(key),
      open: (chatId) => this.openChatOfProject(core, key, chatId),
      topOfList: async () => (await this.listChatsIn(core, key)).chats[0]?.id,
      newChat: () => this.newChatIn(core, key),
    });
  }

  // false: the chat is gone, or works in another project
  private async openChatOfProject(core: ChatCore, key: string, chatId: string): Promise<boolean> {
    const loaded = this.loadedChat(chatId);
    if (loaded) {
      if (this.projectOf(loaded) !== key) return false;
      this.showChat(loaded, { focus: false });
      return true;
    }
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX) || (await this.storedChat(core, chatId))?.projectKey !== key) return false;
    return (await this.selectChatIn(core, chatId)).ok;
  }

  private selectRelativeChat(delta: 1 | -1): Promise<void> {
    return this.chatHost(authorityKeyOfProject(this.selectedProjectKey ?? '')).run('Select Chat', (core) => this.selectRelativeChatIn(core, delta));
  }

  private async selectRelativeChatIn(core: ChatCore, delta: 1 | -1): Promise<void> {
    const key = this.selectedProjectKey;
    const selected = this.views?.selected();
    if (key === undefined || !selected) return;
    const ids = (await this.listChatsIn(core, key)).chats.map((chat) => chat.id);
    if (ids.length < 2) return;
    const current = ids.indexOf(this.chatIdOf(selected));
    if (current < 0) return;
    const target = ids[(current + delta + ids.length) % ids.length];
    if (target !== undefined) await this.selectChatIn(core, target);
  }

  // undefined: projectKey is not a project of the list
  private listChats(projectKey: string): Promise<ShellChatList | undefined> {
    const authority = authorityKeyOfProject(projectKey);
    const unloaded = (): ShellChatList | undefined => (this.remoteProject(projectKey) ? this.chatList(projectKey, [], true) : undefined);
    if (this.mirrorListed(authority)) return this.mirroredChats(projectKey, '', true);
    if (authority !== 'local' && !this.clientFor(authority)) return Promise.resolve(unloaded());
    const listed = this.chatHost(authority).read('List Chats', async (core) => (this.isKnownProject(projectKey, core) ? this.listChatsIn(core, projectKey) : undefined));
    return authority === 'local' ? listed : listed.catch((err: unknown) => this.whileRemoteGone(authority, err, unloaded));
  }

  // A remote engine that went under a read (a halt, a restart past the read's retry, a dropped connection) lists what is
  // loaded, as the read would had it started a moment later.
  private whileRemoteGone<T>(authority: string, err: unknown, answer: () => T): T {
    if (this.clientFor(authority) !== undefined) throw err;
    return answer();
  }

  private async listChatsIn(core: ChatCore, projectKey: string): Promise<ShellChatList> {
    if (!this.isKnownProject(projectKey, core)) throw new Error('Unknown project');
    return this.chatList(projectKey, await this.catalogList(core, projectKey), true);
  }

  private searchChats(projectKey: string, query: string): Promise<ShellChatList | undefined> {
    const authority = authorityKeyOfProject(projectKey);
    const unloaded = (): ShellChatList | undefined => (this.remoteProject(projectKey) ? this.chatList(projectKey, [], false) : undefined);
    if (this.mirrorListed(authority)) return this.mirroredChats(projectKey, query, query.trim() === '');
    if (authority !== 'local' && !this.clientFor(authority)) return Promise.resolve(unloaded());
    const found = this.chatHost(authority).read('Search Chats', async (core) => {
      if (!this.isKnownProject(projectKey, core)) return undefined;
      if (query.trim() === '') return this.listChatsIn(core, projectKey);
      return this.chatList(projectKey, await core.client.searchSessions(projectKey, query), false);
    });
    return authority === 'local' ? found : found.catch((err: unknown) => this.whileRemoteGone(authority, err, unloaded));
  }

  // Loaded chats the catalog does not list lead the list (last viewed first), then the stored sessions as the catalog orders them.
  private chatList(projectKey: string, rows: readonly StoredSession[], withNewChats: boolean): ShellChatList {
    const mirrored = this.mirrorListed(authorityKeyOfProject(projectKey));
    const loaded = this.views?.chats().filter((chat) => this.projectOf(chat) === projectKey) ?? [];
    const bySession = new Map<string, DesktopPanel>();
    const listed = new Set(rows.map((row) => row.id));
    // A chat with no session file yet, or one whose first write the catalog has not listed yet, still shows.
    const unlisted: DesktopPanel[] = [];
    for (const chat of loaded) {
      const sessionId = this.sessionIdOf(chat);
      if (sessionId !== undefined) bySession.set(sessionId, chat);
      if (sessionId === undefined || !listed.has(sessionId)) unlisted.push(chat);
    }
    const chats: ShellChat[] = withNewChats
      ? unlisted.sort((a, b) => (this.lastViewed.get(b) ?? 0) - (this.lastViewed.get(a) ?? 0)).map((chat) => ({
        id: this.chatIdOf(chat),
        ...this.unlistedDesignRow(chat),
        timestamp: Date.now(),
        status: statusOf(this.activityOf(chat)),
        loaded: true,
        ...this.rowWorktree(projectKey, chat, undefined, mirrored),
        actions: chatActions(this.chatIdOf(chat), mirrored),
      }))
      : [];
    const tags = new Set<string>();
    for (const row of rows) {
      const chat = bySession.get(row.id);
      const design = shellDesignOf(row);
      // A tag stored before tags were bounded never reaches the shell, which hands tags back in overlay requests.
      const tag = isShellTag(row.tag) ? row.tag : undefined;
      if (tag !== undefined) tags.add(tag);
      chats.push({
        id: row.id,
        title: storedTitle(row),
        timestamp: row.timestamp,
        ...(design !== undefined ? { design } : {}),
        ...(tag !== undefined ? { tag } : {}),
        ...(row.model ? { model: { provider: row.model.provider, id: row.model.id } } : {}),
        // a chat another device runs on the host is shown by its core's activity, though this window has not loaded it
        status: statusOf(chat ? this.activityOf(chat) : this.sessionActivity.get(`${authorityKeyOfProject(projectKey)}\n${row.id}`)),
        loaded: chat !== undefined,
        ...this.rowWorktree(projectKey, chat, row, mirrored),
        actions: chatActions(row.id, mirrored),
      });
    }
    return { projectKey, chats, tags: [...tags].sort((a, b) => a.localeCompare(b)).slice(0, MAX_OVERLAY_TAGS) };
  }

  // A Chats row's worktree badge and read-only state (AD12 Listing).
  // mirrored: the host has no connection, so the row offers no worktree work
  private rowWorktree(projectKey: string, chat: DesktopPanel | undefined, row: StoredSession | undefined, mirrored: boolean): Pick<ShellChat, 'worktree' | 'readOnly'> {
    const authority = authorityKeyOfProject(projectKey);
    const registry = this.worktreeRegistry(authority) ?? this.remoteRecordsOf(authority);
    const event = chat ? this.worktreeEventOf(chat) : undefined;
    const found = chatRowWorktree(
      {
        ...(event ? { live: { ...(event.worktreeId !== undefined ? { worktreeId: event.worktreeId } : {}), state: event.state } } : {}),
        ...(row ? { stored: { ...(row.worktree ? { worktree: row.worktree } : {}), ...(row.listedFrom !== undefined ? { listedFrom: row.listedFrom } : {}) } } : {}),
      },
      { registry, finish: (record) => this.finishStateOf(record), baseBranch: (record) => this.scm?.rootRepository(this.worktreeProjectKey(authority, record.projectPath))?.branch },
    );
    if (!found.worktree) return { readOnly: found.readOnly };
    if (mirrored) {
      const { finish: _finish, ...shown } = found.worktree;
      return { worktree: shown, readOnly: found.readOnly };
    }
    const newChatIn = found.worktree.status === 'live' ? this.newChatInTarget(found.worktree.worktreeId === undefined ? undefined : registry.get(found.worktree.worktreeId)) : undefined;
    return { worktree: { ...found.worktree, ...(newChatIn ? { newChatIn } : {}) }, readOnly: found.readOnly };
  }

  // Catalog results become the shell's; every refusal reaches the user as exactly one toast (core shows the lease one).
  private mutationResult(result: CatalogResult, failure: string): ChatMutationResult {
    return chatMutationResult(result, failure, {
      log,
      t: (message, ...args) => this.requireLocalization().t(message, ...args),
      render: (text) => this.requireLocalization().render(text),
      error: (message) => void this.notifications.error(message),
      missing: () => this.missingChat(),
    });
  }

  private unwrittenChat(): ChatMutationResult {
    void this.notifications.info(this.requireLocalization().t('This chat has no saved conversation yet.'));
    return { ok: false, reason: 'failed' };
  }

  // The state chatList's row actions come from: a chat of a host with no connection is its read-only mirrored transcript.
  private refusesMirrored(authority: string): boolean {
    return refusesMirrored({
      mirrored: (key) => this.mirrorListed(key),
      hostName: (key) => this.hostName(key),
      t: (message, ...args) => this.requireLocalization().t(message, ...args),
      error: (message) => void this.notifications.error(message),
    }, authority);
  }

  private mirroredChat(chatId: string): ChatMutationResult | undefined {
    return this.refusesMirrored(this.chatAuthority(chatId)) ? { ok: false, reason: 'failed' } : undefined;
  }

  private async renameChat(chatId: string, name: string): Promise<ChatMutationResult> {
    const mirrored = this.mirroredChat(chatId);
    if (mirrored) return mirrored;
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.loadedChat(chatId) ? this.unwrittenChat() : this.missingChat();
    return this.chatHost(this.chatAuthority(chatId)).run('Rename Chat', (core) => this.chatWork.run(chatId, async () => this.mutationResult(await core.client.renameSession(chatId, name), 'rename')));
  }

  private async tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult> {
    const mirrored = this.mirroredChat(chatId);
    if (mirrored) return mirrored;
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.loadedChat(chatId) ? this.unwrittenChat() : this.missingChat();
    return this.chatHost(this.chatAuthority(chatId)).run('Tag Chat', (core) => this.chatWork.run(chatId, async () => this.mutationResult(await core.client.tagSession(chatId, tag), 'tag')));
  }

  // Core deletes lease first and detaches every holder; the detached chat then unloads like any other.
  private async deleteChat(chatId: string): Promise<ChatMutationResult> {
    const mirrored = this.mirroredChat(chatId);
    if (mirrored) return mirrored;
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) {
      const chat = this.loadedChat(chatId);
      if (!chat) return this.missingChat();
      this.forgetHeldMessages(chat);
      this.lastChats.forgetChat(chatId);
      chat.close();
      return { ok: true };
    }
    // the chat's authority before the delete closes the chat that names it
    const authority = this.chatAuthority(chatId);
    const deleted = await this.chatHost(authority).run('Delete Chat', (core) => this.chatWork.run(chatId, async () => {
      const holder = this.loadedChat(chatId);
      const worktreeId = (holder ? this.worktreeEventOf(holder)?.worktreeId : undefined) ?? (await this.storedChat(core, chatId))?.session.worktree?.worktreeId;
      const result = this.mutationResult(await core.client.deleteSession(chatId), 'delete');
      if (result.ok) this.lastChats.forgetChat(chatId);
      if (result.ok && holder && !holder.isDisposed) {
        const key = this.chatKeyOf(holder);
        if (key !== undefined) this.worktreeStates.delete(key);
        this.forgetHeldMessages(holder);
        holder.close();
      }
      return { result, worktreeId };
    }));
    // D33: deleting the last chat that uses a worktree asks whether to delete the worktree too
    if (deleted.result.ok && deleted.worktreeId !== undefined) this.worktreesOf(authority).afterChatDeleted(deleted.worktreeId).catch(this.report('Offering the worktree delete'));
    return deleted.result;
  }

  // A chat the user deletes takes its held messages with it; every other close keeps them for the chat's next page.
  private forgetHeldMessages(chat: DesktopPanel): void {
    const token = chat.heldToken;
    if (!chat.offline && token !== undefined) this.offlineQueue?.forget(token);
  }

  // A chat left memory: by retention, Delete, or the window or core closing (which keep the saved selection).
  private chatClosed(panel: DesktopPanel): void {
    this.servedRoots.release(panel.panelId);
    this.heldPrompts.closed(panel.panelId);
    this.relayedConsents.pageClosed(panel.panelId);
    const projectKey = this.projectOf(panel);
    this.chatsChanged(projectKey);
    if (panel.authority !== 'local') {
      this.saveRemoteChats(panel.authority);
      this.foreignViews.viewClosed(panel.panelId);
    }
    const views = this.views;
    if (this.closingForWorktree.has(panel) || (projectKey !== undefined && this.removingProjects.has(projectKey))) return;
    if (!views || views.retaining(panel) || this.lifecycle.phase !== 'running' || views.selected() !== undefined) return;
    // a chat of another authority than the selected project's was never the selected chat: a hidden local chat unloading while
    // the selected remote project's chat reopens (reselectRemote) or its host connects at launch never moves the selection
    const selectedAuthority = this.selectedProjectKey === undefined ? undefined : authorityKeyOfProject(this.selectedProjectKey);
    if (selectedAuthority !== undefined && selectedAuthority !== panel.authority) return;
    // a host being forgotten closes its chats while its projects are still listed, and selecting one would connect it again
    const forgotten = panel.authority !== 'local' && this.hostBeingForgotten(panel.authority);
    const key = (forgotten ? undefined : projectKey) ?? this.client()?.defaultTarget()?.key;
    if (key !== undefined) this.selectProject(key, false).catch(this.report('Selecting a chat after a close'));
  }

  private onChatActivity(chatKey: string, activity: ChatActivity): void {
    // Fires on every session bind, a folder switch's included.
    this.chatFoldersChanged.fire();
    const previous = this.activity.get(chatKey);
    this.activity.set(chatKey, activity);
    this.notificationCenter.activity(chatKey, activity);
    const panel = this.panelOfCore(chatKey);
    if (!panel) return;
    if (statusOf(previous) !== statusOf(activity)) this.shellStateChanged();
    this.chatChanged(panel);
  }

  // The chat's session, status or conversation may have changed.
  private chatChanged(panel: DesktopPanel): void {
    const projectKey = this.projectOf(panel);
    if (projectKey !== undefined) {
      const chatId = this.chatIdOf(panel);
      // A chat remembered before its first file write is remembered by its session id once it has one.
      this.lastChats.renamed(`${NEW_CHAT_ID_PREFIX}${panel.panelId}`, chatId);
      this.lastChats.chatMoved(chatId, projectKey);
      if (panel === this.views?.selected() && !this.chatElsewhereSelected()) this.selectionChanged(panel);
    }
    if (panel.authority !== 'local') this.saveRemoteChats(panel.authority);
    this.chatsChanged(projectKey);
    this.scheduleRetention();
  }

  private scheduleRetention(): void {
    if (this.retentionScheduled) return;
    this.retentionScheduled = true;
    setImmediate(() => {
      this.retentionScheduled = false;
      this.applyRetention();
    });
  }

  // Unloads what chat-pool says. Each unload waits in the chat's work queue behind any select or catalog write on it, and
  // runs only if the pool still says so then.
  private applyRetention(): void {
    const views = this.views;
    if (!views || !this.core.current() || views.retainingStates || this.lifecycle.phase !== 'running') return;
    const loaded = (key: string): boolean => {
      const { authority, corePanelId } = parseChatKey(key);
      const client = this.clientFor(authority);
      // a remote core that is not ready keeps its chats' entries for the one that replaces it
      return client === undefined ? authority !== 'local' : client.chat(corePanelId) !== undefined;
    };
    for (const key of [...this.worktreeStates.keys()]) if (!loaded(key)) this.worktreeStates.delete(key);
    for (const key of [...this.activity.keys()]) {
      if (loaded(key)) continue;
      this.activity.delete(key);
      this.notificationCenter.panelClosed(key);
      void this.chatReviews.panelClosed(key).catch(this.report('Closing a chat review'));
    }
    for (const panelId of this.chatsToUnload()) {
      const chat = views.panel(panelId);
      const client = chat ? this.clientOf(chat) : undefined;
      if (!chat || !client) continue;
      this.chatWork.run(this.chatIdOf(chat), async () => {
        if (chat.isDisposed || !this.chatsToUnload().includes(chat.panelId)) return;
        // core closes it only while it is still idle and, unloaded as empty, still empty
        log(`[chats] unloading chat ${chat.panelId}`);
        if (!(await this.unloads.unload(chat, () => client.unload(chat.panelId, this.isEmpty(chat))))) log(`[chats] core kept chat ${chat.panelId} loaded`);
      }).catch(this.report('Unloading a chat'));
    }
  }

  private chatsToUnload(): string[] {
    const views = this.views;
    if (!views || !this.core.current() || views.retainingStates || this.lifecycle.phase !== 'running') return [];
    const selected = views.selected();
    return chatsToUnload(views.chats().flatMap((chat) => {
      // A chat whose session core is still setting up is neither idle nor empty yet.
      if (this.corePanelIdOf(chat) === undefined || this.openingInWorktree.has(chat)) return [];
      if (views.retaining(chat)) return [];
      // an unload while the host is away would reach core only on its resume, after messages held meanwhile
      if (chat.authority !== 'local' && !this.authorities?.connection(chat.authority)) return [];
      // held from the moment the settings start opening: a sign-in opens a remote chat's settings straight on the User tab
      const settingsHold = (chat === this.settingsLocalChat || this.settingsOpening.holds(chat)) && this.overlaySettings?.showing() === true;
      const token = chat.heldToken;
      const holdsMessages = token !== undefined && (this.offlineQueue?.queued(token).length ?? 0) > 0;
      return [{
        id: chat.panelId,
        selected: chat === selected || settingsHold || views.leaving(chat),
        active: isActiveActivity(this.activityOf(chat)) || this.browserTabs?.holdsPages(chat) === true || this.designPreviews?.holdsTabs(chat) === true,
        holdsMessages,
        holdsKeptPrompt: this.heldPrompts.startedWithPrompt(chat.panelId) && this.sessionIdOf(chat) === undefined,
        restoring: this.isRestoring(chat),
        hasSession: this.sessionIdOf(chat) !== undefined,
        empty: this.isEmpty(chat),
        lastViewed: this.lastViewed.get(chat) ?? 0,
        ...(this.worktreeEventOf(chat) ? { worktreePhase: this.worktreeEventOf(chat)!.state.phase } : {}),
      }];
    }));
  }

  private chooseClientCertificate(): Promise<void> {
    const localization = this.requireLocalization();
    return chooseClientCertificate({
      page: () => {
        const page = this.browserTabs?.activePage();
        return page?.page && { url: page.page.url, local: page.authority === 'local' };
      },
      probe: async (url) => probeClientCertificates(await openProbeContents(), url),
      ask: (request) => {
        const overlay = this.overlay;
        if (!overlay) throw new Error('The window has no overlay to ask in');
        return overlay.request(request, webContents.getFocusedWebContents() ?? undefined);
      },
      use: (origin, filter) => this.core.run('Choose Client Certificate', (core) => core.client.useClientCertificate(origin, filter)),
      tell: (severity, message) => void (severity === 'info' ? this.notifications.info(message) : this.notifications.error(message)),
      t: (message, ...args) => localization.t(message, ...args),
    });
  }

  private shellFailure(action: string, message: string): (err: unknown) => void {
    return (err) => {
      log(`[shell] ${action} failed: ${errorText(err)}`);
      void this.notifications.error(this.requireLocalization().t(message, errorMessage(err)));
    };
  }

  // Every Files action main refused or that failed (the disk changed after the shell's checks, a name files.exclude hides, a
  // locked file) is one toast naming the entry; a create or rename's name box closes either way.
  private async runFilesAction<T extends FilesMutationResult | FilesDeleteResult | FilesListResult>(action: FilesAction, file: FileRef, run: () => Promise<T>, newName?: string): Promise<T | FilesFailed> {
    const result = await settleFilesAction(run, (line) => log(line), (text) => this.requireLocalization().render(text));
    const name = file.relativePath === '' ? this.roots.resolve(file.projectKey)?.name ?? '' : path.posix.basename(file.relativePath);
    const message = filesFailureMessage((text, ...args) => this.requireLocalization().t(text, ...args), (text) => this.requireLocalization().render(text), action, name, () => this.hostName(authorityKeyOfProject(file.projectKey)), result, newName);
    if (message !== undefined) void this.notifications.error(message);
    return result;
  }

  // A refusal or failure comes back as the reason the project list shows under the project. Removing the project kills its
  // terminals and its worktrees' (AD6), so running ones are asked about first (G22).
  private async removeProject(key: string): Promise<RemoveProjectResult> {
    try {
      // only the host store lists a remote project
      const remote = this.remoteProject(key);
      const project = remote ?? this.projectByKey(key);
      const terminals = this.requireTerminals();
      const idsIn = (projectKey: string): string[] => this.roots.all().filter((root) => root.root.projectKey === projectKey).flatMap((root) => terminals.idsIn(root.key));
      // a remote project's terminals run on its host: the question offers to leave them running there
      const hostTerminals = remote ? await this.askRemoteTerminals(remote) : undefined;
      if (hostTerminals === 'cancel') return { ok: true, removed: false };
      if (!remote) this.removingProjects.add(key);
      return await removeProject(key, {
        project: () => project,
        busy: (projectKey) => this.projectBusy(projectKey),
        waitingChats: (projectKey) => (remote ? [] : this.waitingChats(projectKey)),
        terminals: {
          idsIn: (projectKey) => (remote ? [] : idsIn(projectKey)),
          setupTerminal: (worktreeId) => terminals.taskTerminal(setupTaskKey(worktreeId)),
          toConfirm: (ids) => terminals.toConfirm(ids),
          confirmKill: (ids) => terminals.confirmKill(ids),
        },
        ask: this.ask,
        discard: (chats) => this.discardWaitingChats(chats),
        forgetAccounts: (projectKey) => this.requireForgeHost().forgetProject(projectKey).catch(this.report('Forgetting the project\'s Git hosting accounts')),
        forgetLook: (projectKey) => this.core.run('Remove Project', (core) => core.client.themesForgetProject(projectKey)).catch(this.report('Forgetting the project\'s look and characters')),
        remove: async () => {
          if (remote) {
            this.releaseRemoteTerminals(remote, hostTerminals!);
            await this.hostStore?.removeProject(remote.authorityKey, remote.folderKey, remote.key);
            return;
          }
          this.unloadWorktreeChats(key);
          await this.projects.remove(project.fsPath);
          // before the list change's shell state goes out (setImmediate), which would name a project main no longer lists
          const shown = this.views?.selected();
          if (this.selectedProjectKey === key && !shown) this.selectedProjectKey = undefined;
          // a chat kept behind the removed project's placeholder takes the selection
          else if (this.selectedProjectKey === key && shown && this.projectOf(shown) !== key) this.selectionChanged(shown);
          await this.hostStore?.removeFromOrder(key);
        },
        t: (message, ...args) => this.requireLocalization().t(message, ...args),
      }).finally(() => {
        if (!remote) this.selectAfterRemoval(key, project.fsPath);
      });
    } catch (err) {
      log(`[shell] removing a project failed: ${errorText(err)}`);
      return { ok: false, reason: errorMessage(err) };
    }
  }

  // Locate… on a project whose folder is missing or unavailable (docs/desktop-app.md "Locate"); a refusal or failure shows on
  // the project's row. `offered`: the folder Add Project's offer moves the chats to.
  private locateProject(key: string, offered?: string): Promise<LocateOutcome> {
    return locateOnce(this.locating, key, () => this.locateProjectOnce(key, offered));
  }

  private async locateProjectOnce(key: string, offered: string | undefined): Promise<LocateOutcome> {
    this.locateRefusals.delete(key);
    this.shellStateChanged();
    try {
      const platform = this.requirePlatform();
      const { t } = platform.localization;
      const terminals = this.requireTerminals();
      const authority = authorityKeyOfProject(key);
      if (authority !== 'local' && !this.relocatesOn(authority)) throw new Error(t('Update Damocles on {0} to locate this folder.', this.hostName(authority)));
      const place = authority === 'local' ? this.localLocate(platform) : this.remoteLocate(authority);
      const outcome = await locateProject(key, {
        ...place,
        // the trust update naming the new folder goes to core ahead of the request
        relocate: (request) => {
          this.locateTargets.set(key, request.to);
          this.relocationTargetsChanged.fire(authority);
          return place.relocate(request);
        },
        busy: (projectKey) => this.projectBusy(projectKey),
        confirm: (question) => this.askLocateConfirm(question),
        confirmCloseRoot: (projectKey) => this.requireEditorPane().confirmCloseRoot(projectKey),
        terminals: {
          idsIn: (projectKey) => this.relocationTerminalIds(projectKey),
          confirmKill: (ids) => terminals.confirmKill(ids),
        },
        started: (id, prepared) => {
          this.interruptedLocates.forget(authority, prepared.key);
          this.locatePrepared.set(id, prepared);
          this.relocationNames.set(id, this.listedProjectName(prepared.key) ?? prepared.key);
          // a move core finished before relocate answered is in the mirror already
          this.relocationsChanged(authority);
        },
        interrupted: (prepared) => this.interruptedLocates.record(authority, prepared),
        refused: (projectKey, refusal) => {
          this.locateRefusals.set(projectKey, refusal);
          this.shellStateChanged();
        },
        joinQuit: (work) => this.quitJoins.join(work),
        t: (message, ...args) => t(message, ...args),
      }, offered);
      log(`[projects] Locate of ${key}: ${outcome.kind === 'refused' ? `refused (${outcome.refusal.code})` : outcome.kind}`);
      return outcome;
    } catch (err) {
      log(`[projects] Locate of ${key} failed: ${errorText(err)}`);
      void this.notifications.error(this.requireLocalization().t('Damocles could not locate the project: {0}', errorMessage(err)));
      return { kind: 'cancelled' };
    } finally {
      if (this.locateTargets.delete(key)) this.relocationTargetsChanged.fire(authorityKeyOfProject(key));
    }
  }

  private localLocate(platform: DesktopPlatform): LocatePlace {
    const { t } = platform.localization;
    return {
      project: (projectKey) => {
        const folder = authorityKeyOfProject(projectKey) === 'local' ? this.listedFolder(projectKey) : undefined;
        return folder && { name: this.localProjectName(projectKey), fsPath: folder.fsPath };
      },
      presence: (projectKey) => this.presences.of(projectKey),
      listed: () => this.projects.folders().map((folder) => folder.fsPath),
      pathPresence: (fsPath) => checkWhenAdmitted(() => this.presenceProbe.path(fsPath), this.presenceProbe),
      pathFlavor: path,
      pickFolder: (defaultPath) => platform.nativeDialogs.pickFolder({ title: t('Locate Project Folder'), ...(defaultPath !== undefined ? { defaultPath } : {}) }),
      preflight: (request) => this.core.run('Locate Project', (core) => core.client.relocationPreflight(request)),
      askTrust: (fsPath) => this.trust.askTrust(fsPath),
      closeChats: (projectKey) => this.closeChatsForRelocation(projectKey),
      relocate: (request) => this.core.run('Locate Project', (core) => core.client.relocate(request)),
    };
  }

  // A remote project's Locate: its host's folder browser and trust question, and its host's core, which runs the move on
  // the host; this computer's part follows once that core reports it done.
  private remoteLocate(authority: string): LocatePlace {
    const { t } = this.requireLocalization();
    const host = this.chatHost(authority);
    const os = this.authorityOs(authority);
    return {
      project: (projectKey) => {
        const project = this.remoteProject(projectKey);
        return project?.authorityKey === authority ? { name: project.name, fsPath: project.fsPath } : undefined;
      },
      presence: (projectKey) => this.remotePresences.of(projectKey),
      listed: () => this.remoteProjects().filter((project) => project.authorityKey === authority).map((project) => project.fsPath),
      pathPresence: (fsPath) => remotePathPresence((signal) => this.remoteWorkspace(authority).files.isDirectory(fsPath, signal)),
      pathFlavor: pathFor({ os }),
      pickFolder: (defaultPath) => this.requireRemoteHosts().pickAnywhere(authority, { title: t('Locate Project Folder'), start: defaultPath ?? this.requireConnection(authority).facts.homedir }),
      preflight: (request) => host.run('Locate Project', (core) => core.client.relocationPreflight(request)),
      askTrust: (fsPath) => this.requireRemoteTrust().ask({ key: this.relocationKey(authority, fsPath), authorityKey: authority, folderKey: folderKeyOn(os, fsPath), fsPath, host: this.hostName(authority) }),
      // the hold's mirror update reaches the host's core ahead of preflight, on the same ordered channel
      holdTrust: (fsPath) => this.trustPending.hold(authority, { folderKey: folderKeyOn(os, fsPath), fsPath }),
      closeChats: (projectKey) => this.closeRemoteChatsForRelocation(authority, projectKey),
      relocate: (request) => host.run('Locate Project', (core) => core.client.relocate(request)),
    };
  }

  // Whether the authority's daemon moves project folders: it is connected and listed projects.relocate.
  private relocatesOn(authority: string): boolean {
    return this.authorities?.connection(authority)?.features.includes(RELOCATE_FEATURE) === true;
  }

  // Search's notice for a project whose daemon walks without links; a project not connected fails its search instead.
  private linksNotSearched(projectKey: string): string | undefined {
    const authority = authorityKeyOfProject(projectKey);
    const connection = authority === 'local' ? undefined : this.authorities?.connection(authority);
    if (connection === undefined || !walksWithoutLinks(connection.features)) return undefined;
    return this.requireLocalization().t('Update the Damocles server on {0} to search through links.', visibleText(this.hostName(authority)));
  }

  // The project key a path of an authority's core names, as the shell keys it.
  private relocationKey(authority: string, fsPath: string): string {
    if (authority === 'local') return folderKey(fsPath);
    const located = authority === 'loopback' ? { kind: 'loopback' as const } : this.hostAuthority(authority);
    if (!located) throw new Error(`No saved host is named ${authority}`);
    return projectKeyOf(located, folderKeyOn(this.authorityOs(authority), fsPath));
  }

  // The project's chats on its host close, their records kept beside the skipped ones so they reopen once the move is done;
  // the host's core lets their sessions go before the move starts.
  private async closeRemoteChatsForRelocation(authority: string, key: string): Promise<void> {
    const project = this.remoteProject(key);
    if (!project) return;
    for (const chat of this.views?.chats() ?? []) {
      if (chat.authority !== authority || this.projectOf(chat) !== key) continue;
      const sessionId = this.sessionIdOf(chat);
      if (chat.panelToken !== undefined && sessionId !== undefined) this.skippedRemoteChats.set(chat.panelToken, { authority, sessionId, panelToken: chat.panelToken, projectKey: key });
      chat.close();
    }
    await this.chatHost(authority).run('Locate Project', (core) => core.client.whenFolderReleased(project.fsPath));
  }

  private async askLocateConfirm(question: LocateConfirm): Promise<boolean> {
    const overlay = this.overlay;
    if (!overlay) throw new Error('The Locate dialog has no window to show in');
    this.revealWindow();
    const answer = await overlay.request({
      kind: 'confirm',
      title: question.title,
      message: question.message,
      detail: question.detail,
      ...(question.warning !== undefined ? { warning: { text: question.warning, running: false } } : {}),
      confirmLabel: question.confirmLabel,
      cancelLabel: question.cancelLabel,
      danger: false,
    }, this.window?.webContents);
    return answer.kind === 'confirm' && answer.confirmed;
  }

  // The project's terminals and its worktrees', as Remove Project asks about them.
  private terminalIdsOf(projectKey: string): string[] {
    const terminals = this.requireTerminals();
    return this.roots.all().filter((root) => root.root.projectKey === projectKey).flatMap((root) => terminals.idsIn(root.key));
  }

  // Open on a move another app made asks Locate's own questions: the old root's unsaved editors, then its terminals.
  private async askLocateClose(key: string): Promise<RootCloseAnswers | undefined> {
    const answers = await this.requireEditorPane().confirmCloseRoot(key);
    if (!answers) return undefined;
    return (await this.requireTerminals().confirmKill(this.relocationTerminalIds(key))) ? answers : undefined;
  }

  // A move changes the chat worktrees' root keys (they hold the project's key) and leaves their shells' DAMOCLES_PROJECT_FOLDER
  // naming the old folder, so their terminals and Setup terminals stop with the project's.
  private relocationTerminalIds(projectKey: string): string[] {
    const terminals = this.requireTerminals();
    const folder = this.listedFolder(projectKey);
    const setups = folder ? this.worktreeRecords.liveChatRecords(folder.fsPath).flatMap((record) => terminals.taskTerminal(setupTaskKey(record.id)) ?? []) : [];
    return [...new Set([...this.terminalIdsOf(projectKey), ...setups])];
  }

  // The project's loaded chats close as a core restart closes them, keeping their saved state, and wait beside the chats that
  // did not open while the folder was gone, for the folder to come back or the move to finish; core lets their sessions go
  // before the move starts.
  private async closeChatsForRelocation(key: string): Promise<void> {
    const views = this.views;
    const folder = this.listedFolder(key);
    if (!views || !folder) return;
    this.states.batch(() => {
      for (const chat of views.chats()) {
        if (chat.authority !== 'local' || this.projectOf(chat) !== key) continue;
        const saved = this.states.get(chat.panelId);
        if (saved) this.skippedChats.set(chat.panelId, { saved, projectKey: key });
        views.closeKeepingState(chat);
      }
    });
    await this.core.run('Locate Project', (core) => core.client.whenFolderReleased(folder.fsPath));
  }

  // The moved project's saved file tabs whose file is in the new folder open again there.
  private async reopenRelocatedTabs(files: readonly FileRef[]): Promise<void> {
    const kept = await presentFiles(files, async (file) => {
      const project = this.workspaceProjects().find((candidate) => candidate.key === file.projectKey);
      if (!project) return false;
      const projectFiles = this.requireWorkspaces().forProject(project.key).files;
      const confined = await projectFiles.confineExisting(project, file.relativePath, 'throughLinks');
      return confined.ok && !(await projectFiles.isDirectory(confined.path));
    }, (file, err) => log(`[projects] could not check the moved project's tab ${file.relativePath}: ${errorText(err)}`));
    if (kept.length > 0) await this.requireEditorPane().openInBackground(kept.map((file) => ({ file })));
  }

  // A finished move whose repair waits on the new folder's trust offers Trust, and one that left chat worktrees unlinked
  // offers Retry; each once per relocation and outcome in this run.
  private relocationRepairNotice(authority: string, view: RelocationView): void {
    if (view.state !== 'coreDone' || view.step !== 'repair' || !view.failure) return;
    const shown = `${authority}:${view.id}:${view.failure.code}:${(view.repairFailures ?? []).map((failure) => failure.worktreeId).join(',')}`;
    if (this.repairNotices.has(shown)) return;
    this.repairNotices.add(shown);
    const { t } = this.requireLocalization();
    const project = { name: this.relocationName(authority, view), fsPath: view.from };
    const text = relocationText(view.failure, project, (message, ...args) => t(message, ...args));
    if (view.failure.code === 'untrusted') {
      void this.notificationCenter.notice('warning', text, [t('Trust')]).then(async (chosen) => {
        if (chosen !== 0) return;
        const moved = { key: this.relocationKey(authority, view.to), fsPath: view.to, name: project.name };
        await this.requireProjectTrust().request(moved);
      }).catch(this.report('Trusting the moved project'));
      return;
    }
    if (view.failure.code !== 'repairFailed') return;
    const branches = (view.repairFailures ?? []).map((failure) => {
      const record = authority === 'local' ? this.worktreeRecords.get(failure.worktreeId) : undefined;
      return visibleText(record?.kind === 'chat' ? record.branch : failure.worktreeId);
    });
    const message = branches.length > 0 ? `${text} ${t('Chat worktrees: {0}.', branches.join(', '))}` : text;
    void this.notificationCenter.notice('warning', message, [t('Retry')]).then(async (chosen) => {
      if (chosen !== 0) return;
      this.repairNotices.delete(shown);
      await this.chatHost(authority).run('Locate Project', (core) => core.client.relocationRetry(view.id));
    }).catch(this.report('Re-linking the chat worktrees of a moved project'));
  }

  // The project's name before the move, as Locate or the first sight of the relocation in this run found it, so every notice
  // of one relocation names the project alike, whether or not the list moved on yet.
  private relocationName(authority: string, view: RelocationView): string {
    const known = this.relocationNames.get(view.id);
    if (known !== undefined) return known;
    const listed = [view.from, view.to].map((fsPath) => this.listedProjectName(this.relocationKey(authority, fsPath))).find((name) => name !== undefined);
    const name = listed ?? (authority === 'local' ? path : this.hostPathFlavor(authority)).basename(view.to);
    this.relocationNames.set(view.id, name);
    return name;
  }

  private pausedRelocationOf(key: string): RelocationView | undefined {
    const authority = authorityKeyOfProject(key);
    return this.clientFor(authority)?.relocations().find((candidate) => this.relocationKey(authority, candidate.from) === key && candidate.state === 'paused');
  }

  private async retryRelocation(key: string): Promise<void> {
    const view = this.pausedRelocationOf(key);
    if (view) await this.chatHost(authorityKeyOfProject(key)).run('Locate Project', (core) => core.client.relocationRetry(view.id));
  }

  // Stop moving, after the shell's confirmation: core abandons the paused move, which leaves its mirror, so the row offers
  // Locate… again; a refusal (the move ran on meanwhile) is a notice.
  private async abandonRelocation(key: string): Promise<void> {
    const view = this.pausedRelocationOf(key);
    if (!view) return;
    const authority = authorityKeyOfProject(key);
    const refusal = await this.chatHost(authority).run('Stop Moving', (core) => core.client.relocationAbandon(view.id));
    log(`[projects] Stop moving ${view.id}: ${refusal ? `refused (${refusal.code})` : 'abandoned'}`);
    if (!refusal) return;
    const { t } = this.requireLocalization();
    const text = relocationText(refusal, { name: this.relocationName(authority, view), fsPath: view.from }, (message, ...args) => t(message, ...args));
    void this.notificationCenter.notice('warning', text, []).catch(this.report('Showing why the move was not stopped'));
  }

  // A core's relocations mirror changed: rows follow, and a move that reached coreDone is applied here or offered with Open.
  // What this run kept for a relocation that left the mirror (a new core, Stop moving) is forgotten. client: the core whose
  // mirror changed, which publishes it before its attach is ready, when clientFor still answers undefined.
  private relocationsChanged(authority: string, client: CoreClient | undefined = this.clientFor(authority)): void {
    this.shellStateChanged();
    this.refreshMenuState();
    const views = client?.relocations() ?? [];
    // with no core's mirror read, no relocation left it
    if (client) {
      const mirrored = new Set(views.map((view) => view.id));
      for (const id of this.mirroredRelocations.get(authority) ?? []) if (!mirrored.has(id)) this.forgetRelocation(authority, id);
      this.mirroredRelocations.set(authority, mirrored);
    }
    this.relocationTargetsChanged.fire(authority);
    for (const view of views) {
      this.relocationName(authority, view);
      this.relocationReached(authority, view);
      this.relocationRepairNotice(authority, view);
    }
  }

  private forgetRelocation(authority: string, id: string): void {
    this.locatePrepared.delete(id);
    this.relocationNames.delete(id);
    const shown = `${authority}:${id}:`;
    for (const notice of [...this.repairNotices]) if (notice.startsWith(shown)) this.repairNotices.delete(notice);
  }

  // Requested here: this run's Locate started it under that id and from and to the folders it prepared, a Locate whose request
  // lost its answer included, or this app's core did in an earlier run (a desktop core runs only for this app). A daemon's core
  // runs for every device, so only this run's Locate counts there.
  private relocationReached(authority: string, view: RelocationView): void {
    const adopted = this.locatePrepared.has(view.id) ? undefined : this.interruptedLocates.adopt(authority, view);
    if (adopted) this.locatePrepared.set(view.id, adopted);
    if (view.state !== 'coreDone') return;
    const prepared = this.locatePrepared.get(view.id);
    const located = prepared && preparedMove(prepared, view, (fsPath) => this.relocationKey(authority, fsPath)) ? prepared : undefined;
    const requester: RelocationRequester = located ? { answers: located.answers } : authority === 'local' && view.requestedBy === 'desktop' ? 'thisApp' : 'other';
    this.relocatedOf(authority).reached(view, requester).catch(this.report('Moving the project to its new folder'));
  }

  // The host part of an authority's relocations: this computer's core's, or a remote core's, whose copies here main re-keys.
  private relocatedOf(authority: string): RelocatedProjects {
    if (authority === 'local') return this.relocatedProjects;
    const os = this.authorityOs(authority);
    const hostId = this.savedHostIdOf(authority);
    const known = this.remoteRelocated.get(authority);
    if (known?.os === os && known.hostId === hostId) return known.relocated;
    const { t } = this.requireLocalization();
    const located = authority === 'loopback' ? { kind: 'loopback' as const } : this.hostAuthority(authority);
    if (!located) throw new Error(`No saved host is named ${authority}`);
    const flavor = pathFor({ os });
    const remote = remoteRelocation({
      authority: located,
      authorityKey: authority,
      hostId,
      os: shellPlatform(os),
      store: this.requireHostStore(),
      mirror: (hostId) => this.sessionMirrorOf(hostId),
      relocateBindings: (fromKey, toKey) => this.core.run('Locate Project', (core) => core.client.relocateForgeBindings(fromKey, toKey)),
      relocateLooks: (fromKey, toKey) => this.core.run('Locate Project', (core) => core.client.themesRelocateProject(fromKey, toKey)),
      addHostAlias: (alias) => this.core.run('Locate Project', (core) => core.client.addHostAlias(alias)),
    });
    const relocated = new RelocatedProjects({
      ...remote,
      relocateList: async (from, to, id) => {
        await remote.relocateList(from, to, id);
        this.movedProjects.delete(to.key);
      },
      listed: (key) => {
        const project = this.remoteProject(key);
        return project && { name: project.name };
      },
      absent: (key) => this.remotePresences.absent(key),
      offerOpen: async (view) => (await this.notificationCenter.notice('info', t('Chats moved to {0} on {1}.', visibleText(view.to), this.hostName(authority)), [t('Open')])) === 0,
      askClose: (key) => this.askLocateClose(key),
      isTrusted: (fsPath) => this.requireHostStore().isTrusted(authority, folderKeyOn(os, fsPath)),
      requestTrust: (fsPath) => this.requireRemoteTrust().request({ key: this.relocationKey(authority, fsPath), authorityKey: authority, folderKey: folderKeyOn(os, fsPath), fsPath, host: this.hostName(authority) }),
      savedTabs: (key) => this.windowLayout.editor().tabs.flatMap((tab) => ('file' in tab && tab.kind !== 'searchEditor' && tab.kind !== 'htmlPreview' && tab.file.projectKey === key ? [tab.file] : [])),
      relocateStores: async (from, to) => {
        this.movedProjects.set(to.key, from.key);
        this.lastChats.relocate(from.key, to.key);
        this.windowLayout.relocateProject(from, to, flavor);
        for (const [panelToken, skipped] of [...this.skippedRemoteChats]) if (skipped.projectKey === from.key) this.skippedRemoteChats.set(panelToken, { ...skipped, projectKey: to.key });
        this.saveRemoteChats(authority);
        const selected = this.remoteState?.selected();
        if (selected?.projectKey === from.key) await this.remoteState?.select({ ...selected, projectKey: to.key });
      },
      relocateWorktreeStores: (worktree, fromKey, toKey) => {
        this.windowLayout.relocateProject(
          { key: rootKey({ projectKey: fromKey, worktreeId: worktree.worktreeId }), fsPath: worktree.from },
          { key: rootKey({ projectKey: toKey, worktreeId: worktree.worktreeId }), fsPath: worktree.to },
          flavor,
        );
      },
      // HostStore.replaceProject revokes it in the same write that moves the list entry
      revokeTrust: async () => undefined,
      relocateRoot: (fromRootKey, toRootKey) => this.requireEditorPane().relocateRoot(fromRootKey, toRootKey),
      reopenTabs: (files) => this.reopenRelocatedTabs(files),
      closeOldRoot: (key, answers) => {
        if (!this.requireEditorPane().closeRoot(key, answers)) log(`[projects] the moved project's tabs stay open: one was edited after its question`);
      },
      reopenChats: (toKey) => this.reopenSkippedRemoteChats(toKey),
      select: (key) => this.selectProject(key, false),
      announce: (message) => { void this.notificationCenter.notice('info', message, []); },
      describe: (failure, project) => relocationText(failure, project, (message, ...args) => this.requireLocalization().t(message, ...args)),
      report: (action, err) => this.report(action)(err),
      t: (message, ...args) => this.requireLocalization().t(message, ...args),
    });
    this.remoteRelocated.set(authority, { os, hostId, relocated });
    return relocated;
  }

  // Another device's finished move of a remote project whose folder is missing here, from that host's core.
  private async remoteRelocationsFrom(authority: string): Promise<void> {
    const client = this.clientFor(authority);
    if (!client) return;
    for (const view of await this.remoteMovesFrom(authority, client)) this.relocationReached(authority, view);
  }

  // The moves, by this app or another, that left a listed project of the authority whose folder is not there on its host.
  private async remoteMovesFrom(authority: string, client: CoreClient): Promise<readonly RelocationView[]> {
    if (!client.relocates) return [];
    const absent = this.checkedRemoteProjects(authority).filter((project) => this.remotePresences.absent(project.key)).map((project) => project.key);
    return absent.length === 0 ? [] : client.relocationsFrom(absent);
  }

  // The moves, by this app or another, that left a listed local project whose folder is not there. Core's mirror names only the
  // moves it saw pending in its run, so the launch, every later core start and a folder found missing ask for the rest.
  private async localRelocationsFrom(core: DesktopCore): Promise<readonly RelocationView[]> {
    const absent = this.localProjects().filter((project) => this.presences.absent(project.key)).map((project) => project.key);
    return absent.length === 0 ? [] : core.client.relocationsFrom(absent);
  }

  private async localRelocationsReached(core: DesktopCore): Promise<void> {
    for (const view of await this.localRelocationsFrom(core)) this.relocationReached('local', view);
  }

  // A project's Locate as its row shows it (locateShown).
  private relocationOf(key: string): ShellRelocation | undefined {
    const authority = authorityKeyOfProject(key);
    const view = this.clientFor(authority)?.relocations().find((candidate) => this.relocationKey(authority, candidate.from) === key && candidate.state !== 'coreDone');
    const shown = locateShown(view, this.projectAbsent(key), () => this.chatWorktreeRefusal(key), this.locateRefusals.get(key));
    if (!shown) return undefined;
    const fsPath = authority === 'local' ? this.listedFolder(key)?.fsPath : this.remoteProject(key)?.fsPath;
    const project = { name: this.listedProjectName(key) ?? key, fsPath: fsPath ?? '' };
    const { t } = this.requireLocalization();
    const reason = (coded: Coded): ShellRelocationReason => ({ code: coded.code, text: relocationText(coded, project, (message, ...args) => t(message, ...args)) });
    if (shown.state !== 'move') return { state: shown.state, reason: reason(shown.reason) };
    const { view: move } = shown;
    const { step, progress: { done, total } } = move;
    if (move.state === 'paused') return { state: 'paused', step, done, total, reason: reason(move.failure ?? { code: 'stopped' }), to: move.to, ...(this.clientFor(authority)?.abandons ? { abandonable: true as const } : {}) };
    return { state: 'running', step, done, total, ...(move.failure ? { reason: reason(move.failure) } : {}) };
  }

  // Locate Project Folder…'s target: a project whose folder is not there, on this computer or a daemon that moves folders,
  // with no move of it under way.
  private locatable(key: string | undefined): boolean {
    if (key === undefined || !this.projectAbsent(key) || this.chatWorktreeRefusal(key)) return false;
    const authority = authorityKeyOfProject(key);
    if (authority !== 'local' && !this.relocatesOn(authority)) return false;
    return !(this.clientFor(authority)?.relocations() ?? []).some((view) => this.relocationKey(authority, view.from) === key && view.state !== 'coreDone');
  }

  // A project folder in a chat worktree, by main's mirror of its core's registry: the worktree stays where its record puts it, so
  // Locate is not offered (core's preflight refuses it too).
  private chatWorktreeRefusal(key: string): Coded | undefined {
    const authority = authorityKeyOfProject(key);
    const fsPath = authority === 'local' ? this.listedFolder(key)?.fsPath : this.remoteProject(key)?.fsPath;
    if (fsPath === undefined) return undefined;
    const record = chatRecordHolding(this.worktreeRegistry(authority)?.records() ?? [], fsPath, authority === 'local' ? undefined : this.authorityOs(authority));
    if (record) return { code: 'chatWorktree', params: { projectPath: record.projectPath } };
    return authority === 'local' && folderContains(WORKTREES_ROOT_DIR, fsPath) ? { code: 'chatWorktree' } : undefined;
  }

  private localProjectName(key: string): string {
    return this.client()?.resolve(key)?.label ?? this.listedFolder(key)?.name ?? key;
  }

  private releaseRemoteTerminals(project: RemoteProject, answer: { readonly end: boolean; readonly runs: readonly string[] }): void {
    const terminals = this.requireTerminals();
    const workspace = this.authorities?.connection(project.authorityKey)?.workspace;
    releaseRemoteTerminals(answer, {
      tabs: this.roots.all().filter((root) => root.root.projectKey === project.key).flatMap((root) => terminals.idsIn(root.key)),
      endRun: workspace && ((runId) => workspace.emit('terminals.post', { request: { type: 'kill', id: runId } })),
      kill: (id) => terminals.kill(id),
      detach: (id) => terminals.detach(id),
      log: (line) => log(line),
    });
  }

  // Removing a remote project whose host runs terminals of it asks "End its N terminals on prod-1?" (Cancel focused): Keep
  // running closes their tabs and leaves them on the host, End terminals ends them there. A host that is not connected keeps
  // them, and nothing is asked.
  private async askRemoteTerminals(project: RemoteProject): Promise<'cancel' | { readonly end: boolean; readonly runs: readonly string[] }> {
    const control = this.authorities?.connection(project.authorityKey)?.control;
    if (!control) return { end: false, runs: [] };
    const { runs } = await control.request('listRuns', {});
    const ids = runs.filter((run) => run.kind === 'terminal' && run.projectKey === project.folderKey).map((run) => run.id);
    if (ids.length === 0) return { end: false, runs: [] };
    const { t } = this.requireLocalization();
    const host = this.hostName(project.authorityKey);
    const answer = await this.ask({
      severity: 'danger',
      message: ids.length === 1 ? t('End its terminal on {0}?', host) : t('End its {0} terminals on {1}?', String(ids.length), host),
      detail: t('Terminals left running keep running on {0} after {1} is removed. The host card lists them.', host, visibleText(project.name)),
      actions: [t('Keep running'), t('End terminals')],
      cancelLabel: t('Cancel'),
    });
    if (answer === undefined) return 'cancel';
    return { end: answer === 1, runs: ids };
  }

  // D33's busy rule over the project's loaded chats, those working in its owned folders (worktrees) included. A halted
  // engine runs nothing; a restart or reload under way still answers from the core it starts.
  private projectBusy(projectKey: string): Promise<boolean> {
    const authority = authorityKeyOfProject(projectKey);
    if (authority !== 'local' && !this.clientFor(authority)) return Promise.resolve(false);
    const host = this.chatHost(authority);
    if (host.halted()) return Promise.resolve(false);
    return host.run('Project Busy', (core) => core.client.projectBusy(projectKey));
  }

  // The chats of the project, its worktrees' included, that hold their first prompt for their worktree (rule 6): loaded ones,
  // and saved ones its missing folder kept closed.
  private waitingChats(projectKey: string): WaitingChat[] {
    const loaded = (this.client()?.chats() ?? []).flatMap((chat): WaitingChat[] => {
      const corePanelId = chat.panelId;
      const prompt = (chat.folder.ownerKey ?? chat.folder.key) === projectKey ? chat.heldPrompt as UserContentBlock[] | undefined : undefined;
      if (prompt === undefined) return [];
      const panel = this.panelOfCore(corePanelId);
      const worktreeId = this.worktreeStates.get(corePanelId)?.worktreeId;
      return [{ corePanelId, title: (panel ? this.titleOf(panel) : undefined) ?? '', prompt, ...(worktreeId !== undefined ? { worktreeId } : {}) }];
    });
    const saved = [...this.skippedChats.values()].flatMap(({ saved: chat, projectKey: key }): WaitingChat[] => {
      if (key !== projectKey || !chat.heldPrompt) return [];
      const name = (chat.state as { sessionName?: unknown } | null)?.sessionName;
      return [{ savedPanelId: chat.panelId, title: typeof name === 'string' ? name : '', prompt: chat.heldPrompt }];
    });
    return [...loaded, ...saved];
  }

  // Each loaded chat closes, as Delete closes one, which drops its hold and panels.json entry; core discards its unused
  // worktree. A saved one's entry goes.
  private async discardWaitingChats(chats: readonly WaitingChat[]): Promise<void> {
    const client = this.requireCore().client;
    await Promise.all(chats.map((chat) => {
      if ('savedPanelId' in chat) {
        this.skippedChats.delete(chat.savedPanelId);
        this.states.delete(chat.savedPanelId);
        return undefined;
      }
      const panel = this.panelOfCore(chat.corePanelId);
      if (panel && !panel.isDisposed) panel.close();
      return client.whenWorktreeDiscarded(chat.corePanelId);
    }));
  }

  // With no chat selected after a Remove Project, a project that stayed (a refusal, a failure) is selected again, and after a
  // removal a chat in core's default folder, once core let the project go: until then its default target may still name it.
  private selectAfterRemoval(key: string, fsPath: string): void {
    this.removingProjects.delete(key);
    if (!this.views || this.views.selected()) return;
    if (this.projects.has(fsPath)) {
      this.selectProject(key, false).catch(this.report('Selecting a chat after a refused removal'));
      return;
    }
    this.core.run('Select Project', async (core) => {
      await core.client.whenFolderReleased(fsPath);
      if (!this.views?.selected()) await this.selectProjectIn(core, this.defaultProjectKey(core));
    }).catch(this.report('Selecting a chat after a project removal'));
  }

  // AD12 Projects: a removed project's worktree chats unload and keep their worktrees, which re-adding lists again.
  private unloadWorktreeChats(projectKey: string): void {
    for (const event of [...this.worktreeStates.values()]) {
      if (event.worktreeId === undefined || folderKey(event.projectPath) !== projectKey) continue;
      const panel = this.panelOfCore(event.panelId);
      if (panel && !panel.isDisposed) panel.close();
    }
  }

  private toggleSidebar(): void {
    const current = this.windowLayout.sidebar();
    this.windowLayout.setSidebar({ ...current, sidebarVisible: !current.sidebarVisible });
    if (current.sidebarVisible && this.shellFocusedPart === 'sidebar') this.views?.focusChat();
    this.shellStateChanged();
  }

  private showSidebar(): void {
    const current = this.windowLayout.sidebar();
    if (current.sidebarVisible) return;
    this.windowLayout.setSidebar({ ...current, sidebarVisible: true });
    this.shellStateChanged();
  }

  // Toggle Wallpapers: the user's own switch, which main writes itself, so it works while the engine is down.
  private async toggleWallpapers(): Promise<void> {
    const settings = this.requirePlatform().settings;
    await settings.update(SHOW_WALLPAPERS_SETTING, settings.get<unknown>(SHOW_WALLPAPERS_SETTING) === false, 'user');
  }

  // Next Wallpaper: the shown look's next set, kept in theme-state.json; the editor's preview shows the set it edits instead.
  private async nextWallpaper(): Promise<void> {
    const shown = currentBaseShown();
    const sets = shown.look.wallpapers?.length ?? 0;
    if (sets < 2 || shown.builtin) {
      void this.notificationCenter.notice('info', this.requireLocalization().t('The look on screen has fewer than two wallpaper sets, so there is no next one.'), []);
      return;
    }
    // from the set on screen when the write's turn comes, so two quick presses move two sets on
    await this.themeState.advance(shown.themeId, shown.kind, (position) => {
      const now = Date.now();
      return { index: (cycleAt(position ?? { index: 0, at: now }, sets, shown.look.cycle?.minutes, now).index + 1) % sets, at: now };
    });
  }

  private motionChanged(next: Parameters<typeof setMotionEnvironment>[0]): void {
    setMotionEnvironment({ ...next, ...this.pinnedMotion });
  }

  // Power state that pauses moving wallpapers: on-battery and on-ac where Electron sends them (macOS, Windows), and every
  // THEME_TICK_MS isOnBatteryPower() for Linux, which sends neither, and Windows battery saver, which no event reports.
  private followPower(): void {
    const read = (): void => {
      this.motionChanged({ onBattery: powerMonitor.isOnBatteryPower(), batterySaver: batterySaverOn(process.platform, undefined, (line) => log(line)) === true });
    };
    const onBattery = (): void => this.motionChanged({ onBattery: true });
    const onAc = (): void => this.motionChanged({ onBattery: false });
    powerMonitor.on('on-battery', onBattery);
    powerMonitor.on('on-ac', onAc);
    powerMonitor.on('resume', read);
    read();
    const tick = setInterval(read, THEME_TICK_MS);
    tick.unref();
    this.disposables.push({
      dispose: () => {
        clearInterval(tick);
        powerMonitor.removeListener('on-battery', onBattery);
        powerMonitor.removeListener('on-ac', onAc);
        powerMonitor.removeListener('resume', read);
      },
    });
  }

  // Settings › Appearance's list: core's, every theme validated again here, a broken one's reason in this UI's language.
  private async overlayThemes(): Promise<OverlayThemesResult> {
    const client = this.client();
    // a rejected invoke reaches the page under Electron's own English prefix, so the engine being down is an answer in the UI's language
    if (!client) return { ok: false, error: this.requireLocalization().t("This computer's Damocles engine is not running.") };
    const [{ themes }, { entries }] = await Promise.all([client.themesList(), client.themesHistory()]);
    // System colors as main holds them now: core's copy is a mirror, which may be a change behind the window
    const system = this.themeLibrary?.entry(SYSTEM_THEME_ID);
    const current = themes.map((listing) => (listing.id === SYSTEM_THEME_ID && listing.status === 'ok' && system?.status === 'ok' ? { ...listing, theme: system.theme } : listing));
    const listed = current.map((listing) => overlayThemeEntry(listing, this.requireLocalization()));
    const names = new Map(listed.flatMap((entry): Array<[string, string]> => (entry.status === 'ok' ? [[entry.id, entry.name]] : [])));
    const shown = currentBaseShown();
    if (shown.decidedBy === 'preview') throw new Error('The look without a transient preview was decided by one');
    const settings = this.requirePlatform().settings;
    const { state, now, zone, osKind } = currentScheduleView();
    const scheduleView = { schedule: state.schedule, ...(state.override ? { override: state.override } : {}), now, zone, osKind, systemLocale: this.pinnedSystemLocale ?? app.getSystemLocale() };
    return {
      ok: true,
      themes: listed.map((entry) => {
        const fromName = entry.status === 'ok' && entry.theme.origin?.from !== undefined ? names.get(entry.theme.origin.from) : undefined;
        return fromName === undefined ? entry : { ...entry, fromName };
      }),
      shown: {
        themeId: shown.themeId, kind: shown.kind, decidedBy: shown.decidedBy, ...(shown.until !== undefined ? { until: shown.until } : {}), ...(shown.fallback ? { fallback: shown.fallback } : {}),
        ...(shown.touches !== undefined ? { touched: true as const } : {}),
      },
      preferred: { dark: preferredThemeId(settings.get<unknown>(THEMES_DARK_SETTING)), light: preferredThemeId(settings.get<unknown>(THEMES_LIGHT_SETTING)) },
      mode: themePreference(settings.get<unknown>(THEME_SETTING)),
      schedule: scheduleView,
      history: entries.map((entry) => ({ ...entry, change: shownChange(entry.change, this.requireLocalization()) })),
    };
  }

  // An arrangement core sent, for an agent's pick, its undo or the keep-changes revert, checked again and put in place as a
  // manual pick puts one (ThemeCommands).
  private applyCheckedArrangement(raw: unknown, density?: number): void {
    const arrangement = parseArrangement(raw);
    if (!arrangement) throw new Error('The window arrangement core sent is not valid');
    this.applyArrangement(arrangement, density);
  }

  // A theme's arrangement in this window, clamped to its size and to the minimums at the text size and `density`; the shell
  // takes it as main's own layout (layoutRevision).
  private applyArrangement(arrangement: Arrangement, density: number = currentDensity()): void {
    const window = this.window && !this.window.isDestroyed() ? this.window : undefined;
    const [width = DEFAULT_WINDOW_WIDTH, height = DEFAULT_WINDOW_HEIGHT] = window ? window.getContentSize() : [];
    const current = this.windowLayout.sidebar();
    const room = arrangementRoom(
      window ? { width, height, zoom: window.webContents.getZoomFactor() } : undefined,
      this.savedWindowSize(),
      { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT },
    );
    const next = withArrangement(current, arrangement, room, minimumScale(currentTextSize(), density));
    this.windowLayout.setSidebar(next);
    this.layoutRevision += 1;
    this.shellStateChanged();
    if (current.grid.visible.terminal !== next.grid.visible.terminal) this.postTerminalShown();
  }

  // The size the window opens at before it exists: its saved placement's, or its display's when it opens maximized or full screen.
  private savedWindowSize(): { readonly width: number; readonly height: number } | undefined {
    const placement = this.windowLayout.window();
    if (!placement) return undefined;
    if (!placement.maximized && !placement.fullScreen) return placement.bounds;
    const display = screen.getDisplayMatching(placement.bounds);
    return placement.fullScreen ? display.size : display.workAreaSize;
  }

  // Help › Restart with Damocles Theme: the next run starts in safe start; nothing is written.
  private restartWithDamoclesTheme(): void {
    const args = relaunchArgs(process.argv);
    const relaunch = (): void => app.relaunch({ args: [...args, SAFE_THEME_FLAG] });
    app.once('quit', relaunch);
    void this.lifecycle.quit().then((cancelled) => {
      if (cancelled) app.removeListener('quit', relaunch);
    });
  }

  // Every project's own look as core maps it through a pending relocation; main checks each again before it paints one.
  private async readProjectLooks(client: CoreClient): Promise<void> {
    const { looks } = await client.themesProjectLooks();
    setProjectLooks(looks);
    this.shellStateChanged();
  }

  // Project look… from the project's menu: the dialog in the overlay, then core saves what it answered as one history entry.
  // Selecting the project shows the look; nothing here applies a window arrangement.
  private async openProjectLook(key: string): Promise<ProjectLookResult> {
    const localization = this.requireLocalization();
    const client = this.client();
    const overlay = this.overlay;
    if (!client || !overlay) return { kind: 'failed', reason: localization.t("This computer's Damocles engine is not running.") };
    const name = this.remoteProject(key)?.name ?? this.projectByKey(key).name;
    const { themes } = await client.themesList();
    const entries = themes.map((listing) => overlayThemeEntry(listing, localization));
    const listed = entries.flatMap((entry) => (entry.status === 'ok' ? [{ id: entry.id, name: entry.name, theme: entry.theme }] : []));
    const unusable = entries.flatMap((entry) => (entry.status !== 'ok' && entry.name !== undefined ? [{ id: entry.id, name: entry.name }] : []));
    const settings = this.requirePlatform().settings;
    const look = projectLookOf(key);
    const answer = await overlay.request({
      kind: 'projectLook',
      projectKey: key,
      projectName: name,
      ...(look ? { look } : {}),
      themes: listed,
      ...(unusable.length > 0 ? { unusable } : {}),
      preferred: { dark: preferredThemeId(settings.get<unknown>(THEMES_DARK_SETTING)), light: preferredThemeId(settings.get<unknown>(THEMES_LIGHT_SETTING)) },
      shownKind: currentThemeKind(),
    }, this.window?.webContents);
    if (answer.kind !== 'projectLook') return { kind: 'cancelled' };
    const saved = answer.look;
    await client.themesSetProjectLook({ projectKey: key, look: saved, name });
    await this.readProjectLooks(client);
    // a theme that is listed but cannot show (broken, or of a newer Damocles) still has a name; one that is gone has none
    const savedTheme = saved?.mode === 'full' ? entries.find((entry) => entry.id === saved.themeId) : undefined;
    const themeName = savedTheme?.name;
    const missingTheme = saved?.mode === 'full' && saved.themeId !== BUILTIN_THEME_ID && savedTheme?.status !== 'ok';
    return { kind: 'saved', look: saved === null ? 'none' : saved.mode, ...(themeName !== undefined ? { themeName } : {}), ...(missingTheme ? { missingTheme: true as const } : {}) };
  }

  // The project look dialog's Choose image…: main's file dialog, then core stores and analyzes the image as a wallpaper.
  private async projectLookImage(window: BrowserWindow): Promise<ProjectLookImageResult> {
    const t = (message: string): string => this.requireLocalization().t(message);
    const client = this.client();
    if (!client) return { ok: false, error: t("This computer's Damocles engine is not running.") };
    try {
      const filters = [{ name: t('Images and videos'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'apng', 'mp4', 'm4v', 'webm'] }];
      const picked = await dialog.showOpenDialog(window, { title: t('Choose a Wallpaper Image or Video'), properties: ['openFile'], filters });
      const file = picked.canceled ? undefined : picked.filePaths[0];
      if (file === undefined) return { ok: false, cancelled: true };
      return { ok: true, image: await client.themesImportImage(file), name: path.basename(file) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  // A theme link's card: Settings › Appearance opens (a closed window first) and its modal reads the card from ThemeSharing once it shows.
  private async openInstallCard(): Promise<boolean> {
    this.showWindow();
    const overlay = this.overlay;
    const settings = this.overlaySettings;
    if (!overlay || !settings) return false;
    await overlay.whenLoaded();
    if (this.overlaySettings !== settings) return false;
    settings.show({ section: 'appearance' }).finally(() => this.remoteHosts?.dropUnshownRuns()).catch(this.report('Settings'));
    return settings.sendWhenShown(OVERLAY_CHANNELS.themesInstallChanged, {});
  }

  // Settings' Import: Damocles theme files, VS Code color themes, base16 schemes and GTK, KDE and Qt color schemes. KDE's
  // kdeglobals has no extension, so only All files shows it.
  private async pickThemeImportFile(): Promise<string | undefined> {
    const t = (message: string): string => this.requireLocalization().t(message);
    const filters = [
      { name: t('Themes'), extensions: [THEME_ARCHIVE_EXTENSION, 'json', 'jsonc', 'vsix', 'yaml', 'yml', 'colors', 'conf', 'css'] },
      { name: t('All files'), extensions: ['*'] },
    ];
    const options = { title: t('Import Theme'), properties: ['openFile' as const], filters };
    const window = this.window;
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    return picked.canceled ? undefined : picked.filePaths[0];
  }

  // Export's save dialog, proposing core's file name in the folder the dialog last showed; app.getPath('documents') throws
  // where the Documents folder is missing or redirected.
  private async pickThemeExportPath(fileName: string): Promise<string | undefined> {
    const t = (message: string): string => this.requireLocalization().t(message);
    const options = { title: t('Export Theme'), defaultPath: fileName, filters: [{ name: t('Damocles theme'), extensions: [THEME_ARCHIVE_EXTENSION] }] };
    const window = this.window;
    const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    return result.canceled ? undefined : result.filePath;
  }

  // appearance.json or projects.json, which core writes. Main checks what it holds again before it uses it.
  private readThemeJson(fileName: string): Promise<unknown> {
    return readStateJson(this.themeFiles, path.join(THEMES_DIR, fileName), MAX_STATE_FILE_BYTES, log);
  }

  // projects.json's character pins
  private async readProjectPins(): Promise<void> {
    setProjectPins(parseProjectsFile(await this.readThemeJson(PROJECTS_FILE)));
  }

  // appearance.json's schedule and pick
  private async readAppearanceSchedule(): Promise<void> {
    setAppearanceSchedule(parseAppearanceSchedule(await this.readThemeJson(APPEARANCE_FILE)));
  }

  // The schedule is evaluated by state, so evaluating it again is safe: every THEME_TICK_MS, after sleep and when the screen
  // unlocks, besides every input change and each zone the shell page reports.
  private followThemeClock(): void {
    const tick = setInterval(() => {
      if (!this.themeTickHeld) reevaluateTheme();
    }, THEME_TICK_MS);
    tick.unref();
    powerMonitor.on('resume', reevaluateTheme);
    powerMonitor.on('unlock-screen', reevaluateTheme);
    this.disposables.push({
      dispose: () => {
        clearInterval(tick);
        powerMonitor.removeListener('resume', reevaluateTheme);
        powerMonitor.removeListener('unlock-screen', reevaluateTheme);
      },
    });
  }

  // A shell or chat page crashed: under a custom look the second crash within a minute switches this run to safe start.
  private rendererCrashed(what: string): void {
    if (!this.themeCrashLoop.crashed(Date.now(), !currentShown().builtin)) return;
    log(`[themes] ${what} crashed twice within a minute under a theme other than Damocles; this run shows the Damocles theme`);
    setSafeStart('crashLoop');
    this.shellStateChanged();
  }

  // The safe-start banner's Use my theme: the theme shows again, and the crash count starts over.
  private useMyTheme(): void {
    this.themeCrashLoop.reset();
    setSafeStart(undefined);
    this.shellStateChanged();
  }

  private createThemeDock(window: BrowserWindow, overlay: OverlayHost): ThemeEditorDock {
    return new ThemeEditorDock({
      window,
      preloadPath: path.join(__dirname, 'preload-overlay.js'),
      log: (line) => log(line),
      onChange: () => {
        this.refreshNoticeHolds();
        this.shellStateChanged();
      },
      onRestack: () => overlay.restack(),
      theme: () => currentTheme('root'),
      background: () => trustedBackground(),
      session: (themeId) => this.themeEditorSession(themeId),
      shownName: (entry) => shownThemeName(entry, this.requireLocalization()),
      preview: (preview) => this.agentThemes.editorPreview(preview),
      save: (themeId, theme, pins, baseHash) => this.saveEditedTheme(themeId, theme, pins, baseHash),
      engineDown: () => this.requireLocalization().t("This computer's Damocles engine is not running."),
      baseHash: async (themeId) => {
        const client = this.client();
        return client ? (await client.themesBaseHash(themeId)).hash ?? null : undefined;
      },
      arrangement: () => arrangementOf(this.windowLayout.sidebar()),
      duplicate: async (themeId) => {
        const client = this.client();
        const entry = this.themeLibrary?.entry(themeId);
        if (!client || entry?.status !== 'ok') return { error: this.requireLocalization().t("This computer's Damocles engine is not running.") };
        try {
          return { themeId: (await client.themesDuplicate(themeId, themeCopyName(themeId, entry.theme.name, this.requireLocalization()))).themeId };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      copyNotOpened: () => this.requireLocalization().t('The copy was made, but the theme editor could not open it. Open it from Settings › Appearance.'),
      closed: () => this.openSettings({ section: 'appearance' }),
      openSettings: () => this.openSettings({ section: 'appearance' }),
      peeked: () => {
        if (!window.isDestroyed()) window.webContents.focus();
      },
      pickFontFile: async () => {
        const t = (message: string): string => this.requireLocalization().t(message);
        const picked = await dialog.showOpenDialog(window, { title: t('Add a Font File'), properties: ['openFile'], filters: [{ name: t('Fonts'), extensions: ['woff2', 'woff', 'ttf', 'otf'] }] });
        const file = picked.canceled ? undefined : picked.filePaths[0];
        if (file === undefined) return undefined;
        try {
          return await readPickedFont(file, MAX_FONT_BYTES);
        } catch (err) {
          log(`[themes] the font file could not be read: ${errorText(err)}`);
          throw new Error(t('Damocles could not read the font file.'));
        }
      },
      importFont: async (bytes) => {
        const client = this.client();
        if (!client) throw new Error(this.requireLocalization().t("This computer's Damocles engine is not running."));
        return client.themesImportFont(bytes);
      },
      fontTooLarge: () => this.requireLocalization().t('This font is larger than {0} MB, the most a theme bundles.', String(MAX_FONT_BYTES / 1024 / 1024)),
      pickImageFile: async () => {
        const t = (message: string): string => this.requireLocalization().t(message);
        const filters = [{ name: t('Images and videos'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'apng', 'mp4', 'm4v', 'webm'] }];
        const picked = await dialog.showOpenDialog(window, { title: t('Choose a Wallpaper Image or Video'), properties: ['openFile'], filters });
        return picked.canceled ? undefined : picked.filePaths[0];
      },
      importImage: async (file) => {
        const client = this.client();
        if (!client) throw new Error(this.requireLocalization().t("This computer's Damocles engine is not running."));
        return client.themesImportImage(file);
      },
      allowFlash: async (sha256) => {
        const client = this.client();
        if (!client) throw new Error(this.requireLocalization().t("This computer's Damocles engine is not running."));
        if (!(await client.themesAllowFlash(sha256))) return undefined;
        invalidateWallpaperStats();
        return readWallpaperFlash(THEMES_DIR, sha256, this.themeNotices);
      },
      notChecked: () => this.requireLocalization().t('This file has not been checked for flashing yet, so it cannot be allowed.'),
      pickSpriteFile: async () => {
        const t = (message: string): string => this.requireLocalization().t(message);
        const filters = [{ name: t('Images'), extensions: ['png', 'apng', 'gif', 'webp', 'svg'] }];
        const picked = await dialog.showOpenDialog(window, { title: t('Choose a Character Image'), properties: ['openFile'], filters });
        return picked.canceled ? undefined : picked.filePaths[0];
      },
      importSprite: async (file, strip) => {
        const client = this.client();
        if (!client) throw new Error(this.requireLocalization().t("This computer's Damocles engine is not running."));
        return client.themesImportSprite({ file, ...(strip ? { strip } : {}) });
      },
    });
  }

  // What a theme main read, an open theme card, the transient preview or the open theme editor's imports declare a blob to
  // be: the blobs any page of the app may load.
  private namedBlob(sha256: string): NamedBlob | undefined {
    const font = namedFontBlob(sha256);
    if (font) return { kind: 'font', mime: font.mime };
    const sprite = namedSpriteBlob(sha256);
    if (sprite) return { kind: 'sprite', mime: sprite.mime };
    return namedImageBlob(sha256) ?? this.themeDock?.namedBlob(sha256);
  }

  private async themeEditorSession(themeId: string): Promise<ThemeEditorRead | undefined> {
    // the hash before the read, so a write that lands between the two makes a later save name an older file and be refused
    const baseHash = (await this.client()?.themesBaseHash(themeId).catch((err: unknown) => {
      log(`[themes] the file of ${themeId} could not be hashed for the editor: ${errorText(err)}`);
      return undefined;
    }))?.hash;
    // a theme core just wrote is read before the dock opens on it
    await this.themeLibrary?.load();
    const entry = this.themeLibrary?.entry(themeId);
    if (entry?.status !== 'ok') return undefined;
    const shownKind = currentBaseShown().kind;
    const kind: LookKind = entry.theme.looks[shownKind] ? shownKind : shownKind === 'dark' ? 'light' : 'dark';
    const from = entry.theme.origin?.from;
    const source = from === undefined ? undefined : this.themeLibrary?.entry(from);
    // a built-in's name in the UI's language, as the gallery's card of the same copy says it
    const fromName = source?.status === 'ok' ? shownThemeName(source, this.requireLocalization()) : undefined;
    const wallpapers = Object.fromEntries((await Promise.all(Object.entries(entry.theme.assets ?? {}).filter(([, asset]) => isWallpaperAsset(asset)).map(async ([sha]) => {
      const [stats, palette, flash] = await Promise.all([readWallpaperStats(THEMES_DIR, sha, this.themeNotices), readWallpaperPalette(THEMES_DIR, sha, this.themeNotices), readWallpaperFlash(THEMES_DIR, sha, this.themeNotices)]);
      return stats ? [[sha, { stats, ...(palette ? { palette } : {}), ...(flash ? { flash } : {}) }]] : [];
    }))).flat());
    const contrast = this.requirePlatform().settings.get<unknown>(WALLPAPER_CONTRAST_SETTING) === 'warn' ? 'warn' : 'raiseDim';
    const characterSets = [...(this.themeLibrary?.entries().values() ?? [])].flatMap((other) => (other.status === 'ok' && other.id !== themeId && other.theme.characters
      ? [{ themeId: other.id, name: shownThemeName(other, this.requireLocalization()), characters: other.theme.characters, assets: Object.fromEntries(characterAssets(other.theme).flatMap((sha) => (other.theme.assets?.[sha] ? [[sha, other.theme.assets[sha]!]] : []))) }]
      : []));
    const spriteShas = new Set([...characterAssets(entry.theme), ...characterSets.flatMap((set) => Object.keys(set.assets))]);
    const sprites = Object.fromEntries((await Promise.all([...spriteShas].map(async (sha) => {
      const flash = await readWallpaperFlash(THEMES_DIR, sha, this.themeNotices);
      return flash ? [[sha, flash] as const] : [];
    }))).flat());
    const states = this.views ? this.projectCounts(this.views) : new Map<string, { running: number; waiting: number }>();
    const projects = (this.views ? this.shellState(this.views).projects : []).map((project) => ({ key: project.key, name: project.name, state: characterState(states.get(project.key) ?? { running: 0, waiting: 0 }) }));
    const pins = await this.readThemeJson(PROJECTS_FILE);
    return {
      themeId, builtin: entry.builtin, theme: entry.theme, kind, ...(fromName !== undefined ? { fromName } : {}), wallpapers, wallpaperContrast: contrast,
      sprites, projects, pins: parseProjectsFile(pins), characterSets, nextWallpaperShortcut: acceleratorLabel(NEXT_WALLPAPER_ACCELERATOR, process.platform),
      ...(baseHash !== undefined ? { baseHash } : {}),
    };
  }

  // The draft is written whole: its window arrangement is the one the dock shows, never one read here.
  private async saveEditedTheme(themeId: string, theme: ThemeFile, pins: readonly PinEdit[], baseHash: string): Promise<ThemeEditorResult & { readonly baseHash?: string }> {
    const client = this.client();
    if (!client) return { ok: false, error: this.requireLocalization().t("This computer's Damocles engine is not running.") };
    try {
      const saved = await client.themesSaveTheme({ themeId, theme, ...(pins.length > 0 ? { pins } : {}), baseHash });
      if (saved.changed) return { ok: false, reason: 'changed' };
      // core stored the CSS as this same pass keeps it: the sanitizer is pure and both run it on the saved theme
      const { kept, dropped, droppedMore } = sanitizeThemeCss(theme.css ?? {}, { families: themeCssFamilies(theme) });
      return { ok: true, css: { kept, dropped, droppedMore }, ...(saved.hash !== undefined ? { baseHash: saved.hash } : {}) };
    } catch (err) {
      log(`[themes] saving ${themeId} from the editor failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private shellActions(views: PanelViews, browserTabs: BrowserTabs, overlay: OverlayHost, window: BrowserWindow): ShellActions {
    return {
      state: () => this.shellState(views),
      addProject: reportFailure(() => this.addProject(), this.shellFailure('Add Project', 'Damocles could not add the project: {0}')),
      locateProject: async (key) => {
        await this.locateProject(key);
      },
      retryRelocation: reportFailure((key: string) => this.retryRelocation(key), this.shellFailure('Retry Move', 'Damocles could not retry moving the project: {0}')),
      abandonRelocation: reportFailure((key: string) => this.abandonRelocation(key), this.shellFailure('Stop Moving', 'Damocles could not stop moving the project: {0}')),
      projectLook: async (key) => {
        try {
          return await this.openProjectLook(key);
        } catch (err) {
          log(`[themes] the project look was not saved: ${errorText(err)}`);
          return { kind: 'failed', reason: errorMessage(err) };
        }
      },
      removeProject: (key) => this.removeProject(key),
      selectProject: reportFailure((key: string) => this.selectProject(key, true), this.shellFailure('Select Project', 'Damocles could not open the project: {0}')),
      grantTrust: reportFailure(async (key: string) => {
        const remote = this.remoteProject(key);
        await (remote ? this.requestProjectTrust(remote) : this.trust.requestTrust(this.projectByKey(key).fsPath));
      }, this.shellFailure('Trust Project', 'Damocles could not trust the project: {0}')),
      listChats: (key) => this.listChats(key),
      searchChats: (key, query) => this.searchChats(key, query),
      selectChat: (id) => this.selectChat(id),
      newChat: reportFailure((key: string | undefined, worktree?: NewChatWorktree) => this.newChat(key, worktree), this.shellFailure('New Chat', 'Damocles could not open a new conversation: {0}')),
      newChatInWorktree: reportFailure((request: NewChatInWorktreeRequest) => this.newChatInWorktree(request), this.newChatInWorktreeFailure()),
      worktreeOptions: (key) => this.worktreeOptions(key),
      showFolder: reportFailure(async (request: ShowFolderRequest) => this.showFolder(request), this.shellFailure('Show Folder', 'Damocles could not switch the folder: {0}')),
      worktreeFinish: reportFailure((request: WorktreeFinishRequest) => this.worktreeFinish(request), this.shellFailure('Worktree Action', 'The worktree action failed: {0}')),
      renameChat: reportFailure((id: string, name: string) => this.renameChat(id, name), this.shellFailure('Rename Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      tagChat: reportFailure((id: string, tag: string | null) => this.tagChat(id, tag), this.shellFailure('Tag Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      deleteChat: reportFailure((id: string) => this.deleteChat(id), this.shellFailure('Delete Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      // A popup the overlay could not show (no page loaded or loading, no acknowledgement, a crash or reload) answers as dismissed.
      requestOverlay: reportFailure(
        (request: OverlayRequest, returnFocus: WebContents) => this.requestFromShell(overlay, request, returnFocus),
        this.shellFailure('Show Popup', 'Damocles could not open the menu or dialog: {0}'),
        OVERLAY_DISMISSED,
      ),
      openAppMenu: (anchor) => popupApplicationMenu(window, anchor),
      toggleTheme: () => { this.themeCommands.toggle().catch(this.themeCommands.failed('Toggle Theme')); },
      renameHost: reportFailure(
        (hostId: string, name: string) => this.requireRemoteHosts().rename(hostId, name),
        // null is the one report: the shell's rename field says the name was not saved
        (err) => log(`[shell] Rename Host failed: ${errorText(err)}`),
        null,
      ),
      renameHostOnCard: reportFailure(async (hostId: string) => { await this.requireRemoteHosts().openConnect(hostId, { card: 'rename' }); }, this.shellFailure('Rename Host', 'Damocles could not open the Connect dialog: {0}')),
      showHostCard: reportFailure(async (hostId: string, anchor: OverlayRect) => { await this.requireRemoteHosts().openConnect(hostId, { card: 'show', anchor }); }, this.shellFailure('Host Details', 'Damocles could not open the Connect dialog: {0}')),
      openConnect: reportFailure(async () => this.openConnect(undefined), this.shellFailure('Connect to Host', 'Damocles could not open the Connect dialog: {0}')),
      openHostFolder: reportFailure(async (hostId: string) => this.openConnect(hostId), this.shellFailure('Open Folder on Host', 'Damocles could not open the Connect dialog: {0}')),
      setProjectsView: reportFailure((view: ProjectsView) => this.requirePlatform().settings.update(PROJECTS_VIEW_SETTING, view, 'user'), this.shellFailure('Projects View', 'Damocles could not change the Projects section: {0}')),
      setProjectGroupCollapsed: reportFailure(
        (group: string, collapsed: boolean) => this.requireHostStore().setGroupCollapsed(group, collapsed, () => this.shownGroups()),
        this.shellFailure('Collapse Project Group', 'Damocles could not change the Projects section: {0}'),
      ),
      reorderProjects: reportFailure(
        (order: readonly string[]) => this.requireHostStore().setOrder(order, () => this.listedProjectKeys()),
        // false is the one report: the shell's inline alert says the order was not saved
        (err) => log(`[shell] Reorder Projects failed: ${errorText(err)}`),
        false,
      ),
      reorderProjectGroups: reportFailure(
        (groupOrder: readonly string[]) => this.requireHostStore().setGroupOrder(groupOrder, () => this.shownGroups()),
        (err) => log(`[shell] Reorder Project Groups failed: ${errorText(err)}`),
        false,
      ),
      openAsProject: reportFailure(
        (request: OpenAsProjectRequest): Promise<OpenAsProjectResult | null> => openAsProject(this.projectOpening(), request),
        this.shellFailure('Open as Project', 'Damocles could not open the folder as a project: {0}'),
        null,
      ),
      listWslDistros: () => this.requireRemoteHosts().refreshDistros(),
      // a refusal comes back as a code; an unexpected failure is shown here and rejects the call
      reopenInWsl: async (projectKey: string, distro: string | undefined) => {
        try {
          return await reopenInWsl(this.reopenDeps(), projectKey, distro);
        } catch (err) {
          this.shellFailure('Reopen in WSL', 'Damocles could not reopen the folder in WSL: {0}')(err);
          throw err;
        }
      },
      // a refusal comes back as a code; an unexpected failure is shown here and rejects the call
      reopenInContainer: async (projectKey: string) => {
        try {
          return await this.reopenInContainer(projectKey);
        } catch (err) {
          this.shellFailure('Reopen in Container', 'Damocles could not reopen the folder in a container: {0}')(err);
          throw err;
        }
      },
      rebuildContainer: reportFailure(async (projectKey: string) => {
        const hostId = this.savedHostIdOf(authorityKeyOfProject(projectKey));
        if (hostId === undefined || this.hostStore?.host(hostId)?.kind !== 'container') throw new Error(notContainerProjectText(this.requireLocalization().t));
        await this.requireRemoteHosts().openConnect(hostId, { card: 'rebuild' });
      }, this.shellFailure('Rebuild Container', 'Damocles could not open the Rebuild Container confirmation: {0}')),
      dismissWslNotice: async (projectKey: string) => {
        if (!this.projects.folders().some((folder) => folderKey(folder.fsPath) === projectKey)) throw new Error('Not a local project of the list');
        await this.requireHostStore().dismissWslNotice(projectKey);
        this.shellStateChanged();
      },
      reconnectHost: reportFailure(async (hostId: string) => this.reconnectHost(hostId), this.shellFailure('Reconnect', 'Damocles could not reconnect to the host: {0}')),
      // the Connect dialog on the host's attempt, its waiting prompt included, closing once the host connects
      signInHost: reportFailure(async (hostId: string) => this.openConnect(hostId, { purpose: 'signIn' }), this.shellFailure('Connect to Host', 'Damocles could not open the Connect dialog: {0}')),
      showHostLog: reportFailure((hostId: string) => this.requireRemoteHosts().showLog(hostId), this.shellFailure('Show log', 'Damocles could not show the host\'s log: {0}')),
      switchHostWhenIdle: reportFailure(async (hostId: string) => this.switchHostWhenIdle(hostId), this.shellFailure('Switch when they finish', 'Damocles could not switch the host to this version: {0}')),
      switchHostNow: reportFailure(async (hostId: string) => this.switchHostNow(hostId), this.shellFailure('Switch now', 'Damocles could not switch the host to this version: {0}'), false),
      restartEngine: (authority) => this.restartEngine(authority ?? 'local'),
      toggleSidebar: () => this.toggleSidebar(),
      showSidebar: () => this.showSidebar(),
      windowControl: (control) => {
        if (control === 'minimize') window.minimize();
        else if (control === 'close') window.close();
        else if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      },
      openSettings: (section) => this.openSettings(section !== undefined ? { section } : {}),
      update: () => this.requireUpdates().snapshot(),
      runUpdateAction: (action) => runUpdateAction(action, this.aboutDeps()),
      setContentBounds: (bounds) => views.setContentBounds(bounds),
      setThemeDockBounds: (bounds) => this.themeDock?.setBounds(bounds),
      setPageMotion: ({ visible, reducedMotion }) => {
        this.shellPageVisible = visible;
        this.motionChanged({ visible, osReducedMotion: reducedMotion });
        this.refreshNoticeHolds();
      },
      setTimeZone: (zone) => {
        if (setReportedTimeZone(zone)) log(`[themes] the theme schedule follows the time zone ${zone}`);
      },
      endThemeDockPeek: () => this.themeDock?.setPeek(false),
      useMyTheme: () => this.useMyTheme(),
      keepThemeChanges: reportFailure(() => this.agentThemes.keep(), this.shellFailure('Keep Theme Change', 'Damocles could not keep the theme change: {0}')),
      revertThemeChanges: reportFailure(() => this.agentThemes.revert(), this.shellFailure('Revert Theme Change', 'Damocles could not revert the theme change: {0}')),
      stopShowingProposal: reportFailure(() => this.agentThemes.stopShowing(), this.shellFailure('Stop Showing', 'Damocles could not stop showing the proposal in the window: {0}')),
      revokeScreenshotGrant: reportFailure((id: string) => this.agentThemes.revokeNotice(id), this.shellFailure('Revoke Screenshots', 'Damocles could not revoke the chat\'s screenshot permission: {0}')),
      dismissScreenshotNotice: (id) => this.agentThemes.dismissNotice(id),
      themeApplied: (revision) => {
        if (this.window && !this.window.isDestroyed()) this.themeAcks.acknowledged(this.window.webContents, revision);
      },
      documentGone: () => {
        if (this.window && !this.window.isDestroyed()) this.themeAcks.forget(this.window.webContents);
      },
      rendererGone: () => this.rendererCrashed('the window'),
      // Main owns the sidebar's visibility and the grid's slots, visibility and maximized pane. The shell owns the sizes and
      // Search states while it runs, each part reporting only its own fields, so main stores them without publishing.
      setSidebarLayout: (reported) => this.windowLayout.setSidebar({ ...this.windowLayout.sidebar(), ...reported }),
      setGridSizes: (sizes) => {
        const current = this.windowLayout.sidebar();
        this.windowLayout.setSidebar({ ...current, grid: { ...current.grid, ...sizes } });
      },
      layoutMove: (pane, slot) => this.layoutMove(pane, slot),
      toggleEditor: () => this.toggleGridPane('editor'),
      toggleTerminal: () => this.toggleTerminal(false),
      toggleMaximize: (pane) => this.setGrid(toggleGridMaximize(this.windowLayout.sidebar().grid, pane)),
      dropZonesPointer: (pointer) => {
        if (overlay.isOpen('dropZones')) overlay.send(OVERLAY_CHANNELS.dropZonesPointer, pointer);
      },
      openQuickOpen: () => this.openQuickOpen('files'),
      showCommands: () => this.openQuickOpen('commands'),
      search: {
        start: (request) => this.requireSearch().start(request),
        cancel: () => this.requireSearch().cancel(),
        clear: () => this.requireSearch().clear(),
        dismiss: (request) => this.requireSearch().dismiss(request),
        copy: (request) => this.requireSearch().copy(request),
        confirmReplace: (request) => this.requireSearch().confirmReplace(request),
        replace: (request) => this.requireSearch().replace(request),
        preview: (request) => this.requireSearch().preview(request),
        findInFolder: (folder) => this.requireSearch().findInFolder(folder),
      },
      scm: {
        state: () => this.requireScm().state(),
        select: (raw) => this.requireScm().select(raw),
        run: (raw) => this.requireScm().run(raw),
        commit: (raw) => this.requireScm().commit(raw),
        generateMessage: (raw) => this.requireScm().generateMessage(raw),
        fileDiff: (raw) => this.requireScm().fileDiff(raw),
        copy: (raw) => this.requireScm().copy(raw),
        commitInput: (raw) => this.requireScm().commitInput(raw),
        amend: (raw) => this.requireScm().amend(raw),
        artifacts: (raw) => this.requireScm().artifacts(raw),
        quickDiffBase: (raw) => this.requireScm().quickDiffBase(raw),
        blame: (raw) => this.requireScm().blame(raw),
        timeline: (raw) => this.requireScm().timeline(raw),
        history: (raw) => this.beforeHistory().then(() => this.requireScm().history(raw)),
        commitDetails: (raw) => this.requireScm().commitDetails(raw),
        mergeInputs: (raw) => this.requireScm().mergeInputs(raw),
        mergeFile: (raw) => this.requireScm().mergeFile(raw),
        resource: (raw) => this.requireScm().resource(raw),
      },
      ports: this.requirePorts().actions,
      forge: {
        repoAccounts: (raw) => this.requireForgeHost().repoAccounts(raw),
        chooseAccount: (raw) => this.requireForgeHost().chooseAccountFromShell(raw),
        openAccounts: (raw) => this.requireForgeHost().openAccountsFromShell(raw),
        ciStatus: (raw) => this.requireForgeHost().ciStatusFromShell(raw),
        ciWatch: (raw) => this.requireForgeHost().ciWatchFromShell(raw),
        showPipeline: (raw) => this.requireForgeHost().showPipelineFromShell(raw),
        jobLogOpen: (raw) => this.requireForgeHost().jobLogOpenFromShell(raw),
        jobAction: (raw) => this.requireForgeHost().jobActionFromShell(raw),
        openOnServer: (raw) => this.requireForgeHost().openOnServerFromShell(raw),
        link: (raw) => this.runForgeLink(parseForgeLinkRequest(raw)),
        commitStatus: (raw) => this.requireForgeHost().commitStatusFromShell(raw),
        historyContext: (raw) => this.requireForgeHost().historyContextFromShell(raw),
        authorAvatars: (raw) => this.requireForgeHost().authorAvatarsFromShell(raw),
        containingChange: (raw) => this.requireForgeHost().containingChangeFromShell(raw),
        jobLog: (tabId) => this.requireJobLogTabs().jobLog(tabId),
        jobLogRead: (tabId) => this.requireJobLogTabs().readNow(tabId),
        jobLogVisible: (tabId, visible) => this.requireJobLogTabs().setVisible(tabId, visible),
      },
      review: {
        fileDiff: (raw) => this.chatReviews.fileDiff(raw),
        setScope: (raw) => this.chatReviews.setScope(raw),
        send: (raw) => this.chatReviews.send(raw),
        discard: (raw) => this.chatReviews.discard(raw),
        setDrafts: (raw) => this.chatReviews.setDrafts(raw),
      },
      searchEditor: {
        openNew: (request) => this.requireSearch().openNew(request),
        setConfig: (documentId, config) => this.requireSearch().setConfig(documentId, config),
        run: (documentId) => this.requireSearch().run(documentId),
        openResult: (request) => this.requireSearch().openResult(request),
      },
      editor: {
        state: () => this.requireEditorPane().state(),
        content: (documentId) => this.requireEditorPane().content(documentId),
        // main reports a refused open; the shell shows nothing of its own
        open: (request) => this.requireEditorPane().openFromUser(request.projectKey, request.relativePath, {
          ...(request.line !== undefined ? { line: request.line } : {}),
          ...(request.as !== undefined ? { as: request.as } : {}),
          ...(request.preserveFocus !== undefined ? { preserveFocus: request.preserveFocus } : {}),
          ...(request.toSide !== undefined ? { toSide: request.toSide } : {}),
        }),
        tab: (request) => this.requireEditorPane().tabAction(request.action, request.tabId),
        edit: (documentId, edit) => this.requireEditorPane().edit(documentId, edit),
        save: (request, as) => this.requireEditorPane().save(request.documentId, request.version, request.text, as),
        conflict: (request) => this.requireEditorPane().conflict(request.documentId, request.action),
        format: (request) => this.requireFormatter().format(request.documentId, request.text, request.reason),
        formatFailed: (failure) => this.requireFormatter().builtinFailed(failure.documentId, failure.reason, failure.timedOut, failure.message),
        openLink: (request) => { this.openEditorLink(request).catch(this.report('Open Link')); },
        selection: (documentId, range) => this.requireEditorPane().select(documentId, range),
        mention: (tabId) => this.requireEditorPane().mention(tabId),
        uploadMergeInputs: (tabId) => this.requireEditorPane().uploadMergeInputs(tabId),
        completeUploadMerge: (tabId) => this.requireEditorPane().completeUploadMerge(tabId),
        setFocusOverlay: (open) => views.setFocusOverlay(open),
        focusPage: (tabId) => this.requireEditorPane().focusPage(tabId),
        flushed: (requestId) => this.requireEditorPane().flushed(requestId),
      },
      browser: {
        action: (request) => browserTabs.action(request.tabId, request.action),
        navigate: (request) => browserTabs.navigate(request.tabId, request.url),
        setBounds: (bounds, radius) => browserTabs.setBounds(bounds, radius),
      },
      design: {
        set: ({ tabId, ...change }) => this.requireDesignPreviews().set(tabId, change),
        action: async ({ tabId, action }) => {
          if (action === 'screenshot') return this.designScreenshot(tabId);
          if (action === 'openInBrowser') return this.requireDesignPreviews().openInBrowser(tabId);
          this.requireDesignPreviews().navigate(tabId, action);
        },
        setBounds: (frame) => this.designPreviews?.setBounds(frame),
        freeze: (tabId) => this.requireDesignPreviews().freeze(tabId),
        markupEnter: (tabId) => this.requireDesignPreviews().markupEnter(tabId),
        markupExit: (tabId) => this.requireDesignPreviews().markupExit(tabId),
        markupSend: (request) => this.designMarkupSend(request),
        tweakApply: ({ tabId, property, token }) => this.requireDesignPreviews().applyTweak(tabId, property, token),
        tweakReset: (tabId) => this.requireDesignPreviews().resetTweaks(tabId),
        tweakKeep: (request) => this.designTweakKeep(request),
        lastFrame: (tabId) => this.requireDesignPreviews().lastFrame(tabId),
        shellLoaded: () => this.designPreviews?.shellLoaded(),
      },
      htmlPreview: {
        action: (request) => this.requireHtmlPreviews().action(request),
        setBounds: (frame) => this.htmlPreviews?.setBounds(frame),
      },
      files: {
        list: (projectKey, relativeDir, report) => (report
          ? this.runFilesAction('list', { projectKey, relativePath: relativeDir }, () => this.requireFileTree().list(projectKey, relativeDir))
          : this.requireFileTree().list(projectKey, relativeDir)),
        collapsed: (folder) => this.fileTree?.collapsed(folder.projectKey, folder.relativePath),
        create: (request) => this.runFilesAction(
          'create',
          { projectKey: request.projectKey, relativePath: request.relativeDir === '' ? request.name : `${request.relativeDir}/${request.name}` },
          () => this.requireFileTree().create(request.projectKey, request.relativeDir, request.name, request.kind),
        ),
        rename: (file, newName) => this.runFilesAction('rename', file, () => this.requireEditorPane().fileRenamed(
          file.projectKey,
          file.relativePath,
          () => this.requireFileTree().rename(file.projectKey, file.relativePath, newName),
        ), newName),
        delete: (file) => this.runFilesAction('delete', file, () => this.requireFileTree().delete(file.projectKey, file.relativePath)),
        copyPath: async (file, relative) => {
          await this.runFilesAction('copyPath', file, () => this.requireFileTree().copyPath(file.projectKey, file.relativePath, relative));
        },
        reveal: async (file) => {
          await this.runFilesAction('reveal', file, () => this.requireFileTree().reveal(file.projectKey, file.relativePath));
        },
        mention: (file) => this.mentionInSelectedChat(file),
        copyIn: (request) => this.requireTransferGestures().copyIn(request),
        pickCopyIn: (folder) => this.requireTransferGestures().pickCopyIn(folder),
        dropRow: (request) => this.requireTransferGestures().dropRow(request),
        setClipboard: (request) => this.filesClipboard.set(request.op, request.ref),
        clearClipboard: () => this.filesClipboard.clearCut(),
        paste: (toDir) => this.requireTransferGestures().paste(toDir),
        download: (file) => this.requireTransferGestures().download(file),
        cancelTransfer: (transferId) => this.requireFileTransfers().cancel(transferId),
      },
      setFocusedPart: (part) => {
        this.shellFocusedPart = part;
        if (part !== 'keepChanges') this.keepFocus.left();
        this.partFocused(part ?? undefined);
        this.refreshMenuState();
      },
      holdScreenshotNotice: (id, reason, held) => {
        if (reason === 'focus' && !held) this.noticeFocus.left();
        else if (reason === 'focus' && this.agentThemes.screenshotNotice()?.id === id) this.noticeFocus.entered(this.lastFocusedPart ?? 'chat');
        this.agentThemes.holdNotice(id, reason, held);
      },
      terminal: {
        state: () => this.requireTerminals().state(),
        has: (id) => this.requireTerminals().has(id),
        create: (request) => this.requireTerminals().create(request, false),
        openNew: () => { this.newTerminal().catch(this.report('New Terminal')); },
        openNewMenu: (anchor) => this.openNewTerminalMenu(anchor).catch(this.report('New Terminal')),
        input: (id, data) => this.requireTerminals().input(id, data),
        resize: (id, cols, rows) => this.requireTerminals().resize(id, cols, rows),
        ack: (id, chars) => this.requireTerminals().ack(id, chars),
        kill: (id) => { this.requireTerminals().requestKill([id]).catch(this.report('Kill Terminal')); },
        restart: (id) => { this.requireTerminals().restart(id).catch(this.report('Restart Terminal')); },
        clear: (id) => this.requireTerminals().clear(id),
        select: (id) => this.requireTerminals().select(id),
        split: (id) => { this.requireTerminals().split(id).catch(this.report('Split Terminal')); },
        unsplit: (id) => this.requireTerminals().unsplit(id),
        move: (move) => this.requireTerminals().move(move),
        joinPick: (id) => { this.joinTerminals(id).catch(this.report('Join Terminals')); },
        resizePanes: (groupId, sizes) => this.requireTerminals().resizePanes(groupId, sizes),
        setListWidth: (rem) => this.requireTerminals().setListWidth(rem),
        shellLoaded: () => this.requireTerminals().shellLoaded(),
        paste: (request) => { this.terminalPaste.paste(request).catch(this.report('Paste')); },
        setInputFocused: (id) => {
          this.terminalInputFocused = id;
          if (id !== null) this.requireTerminals().inputFocused(id);
          this.refreshMenuState();
        },
        resolveLinks: (request) => {
          const terminals = this.requireTerminals();
          if (!terminals.has(request.id)) throw new Error('Unknown terminal');
          const base = terminals.linkBase(request.id);
          // a host that is away has no file to link, and its answer is never cached for when it is back
          return base && this.linksReachable(base) ? this.terminalLinks.resolveAll(request.paths, base) : Promise.resolve(request.paths.map(() => null));
        },
        openLink: (request) => { this.openTerminalLink(request).catch(this.report('Open Link')); },
        openWebLink: (request) => { this.openTerminalWebLink(request).catch(this.report('Open Link')); },
        rename: (id, name) => this.requireTerminals().rename(id, name),
        pickIcon: (id) => { this.pickTerminalIcon(id).catch(this.report('Change Icon')); },
        pickColor: (id) => { this.pickTerminalColor(id).catch(this.report('Change Color')); },
        selectDefaultProfile: () => { this.selectDefaultTerminalProfile().catch(this.report('Select Default Profile')); },
        addToChat: (request) => { this.addTerminalOutputToChat(request).catch(this.shellFailure('Add to Chat', 'Damocles could not add the terminal output to the chat: {0}')); },
      },
      gestures: {
        pasteKey: () => {
          if (this.terminalInputHasFocus()) this.terminalPaste.allow('clipboard');
        },
        middleClick: () => this.terminalPaste.allow('selection'),
        contextMenu: () => this.shellMenuGrant.grant(true),
        blurred: () => {
          this.shellMenuGrant.clear();
          this.terminalPaste.clear();
        },
      },
    };
  }

  // The xterm the shell reported is still the command target, and the part holding focus is the one that terminal is in.
  private terminalInputHasFocus(): boolean {
    const target = this.terminals?.target();
    return target !== undefined && target.id === this.terminalInputFocused && this.focusedPart() === (target.placement === 'editor' ? 'editor' : 'terminal');
  }

  // The bell's center marks every entry seen once the overlay shows it; choosing a row closes it, and main then runs the row's action.
  private async requestFromShell(overlay: OverlayHost, request: OverlayRequest, returnFocus: WebContents): Promise<OverlayAnswer> {
    const shown = request.kind === 'notifications' ? () => this.notificationCenter.markSeen() : undefined;
    const platform = this.requirePlatform();
    const answer = await askShellMenu(request, {
      ask: (shownRequest) => overlay.request(shownRequest, returnFocus, shown),
      takeMenuGrant: () => this.shellMenuGrant.take() === true,
      label: (action) => platform.localization.t(action === 'cut' ? 'Cut' : action === 'copy' ? 'Copy' : 'Paste'),
      page: returnFocus,
      allowTerminalPaste: () => this.terminalPaste.allow('clipboard'),
      log: (line) => log(line),
    });
    if (answer.kind === 'notifications') {
      if (answer.action === 'open') this.notificationCenter.open(answer.entryId);
      else this.notificationCenter.answer(answer.entryId, answer.index);
    }
    if (answer.kind === 'dropZones' && request.kind === 'dropZones' && answer.slot !== null) this.layoutMove(request.pane, answer.slot);
    return answer;
  }

  private startEditor(platform: DesktopPlatform, localization: DesktopLocalizationService): void {
    const t = (message: string, ...args: Array<string | number>): string => localization.t(message, ...args);
    // every root a renderer may name files in (AD5, rule 19): the project folders and their live chat worktrees
    const projects = (): readonly Project[] => this.roots.all();
    const report = (line: string): void => log(line);
    const workspaces = this.requireWorkspaces();
    void this.rootSpellings.retain(this.roots.all());
    const documents = new DocumentService({
      projects,
      spellings: this.rootSpellings,
      workspaces,
      authorityOs: (authority) => this.authorityOs(authority),
      ask: this.ask,
      t,
      render: (text) => localization.render(text),
      log: report,
      pickSavePath: (defaultPath) => this.pickSavePath(defaultPath),
      backups: this.backups,
      hostLabel: (authority) => ({ hostId: this.hostIdOf(authority), name: this.hostName(authority) }),
      uploadsConflicted: (authority, conflicted) => this.uploadsConflicted(authority, conflicted),
      warn: (message) => void this.notifications.warn(message),
      reopen: (document) => this.requireEditorPane().showHeld(document),
      sessionFiles: sessionFileEngines({
        host: (authority) => (authority === 'local' ? this.core : this.remoteCores.get(authority)?.host),
        features: (authority) => this.authorities?.connection(authority)?.features,
      }),
      settings: {
        locate: (scope) => {
          const located = locateSettingsFile(platform, scope);
          return typeof located === 'string' ? located : undefined;
        },
        save: (scope, filePath, content, baseVersion) => saveSettingsFileText(platform, scope, filePath, content, baseVersion),
      },
    });
    const fileTree = new FileTree({
      projects,
      exclude: () => {
        const value = platform.settings.get<unknown>(FILES_EXCLUDE_SETTING);
        return isDesktopSettingValue(FILES_EXCLUDE_SETTING, value) ? (value as Record<string, unknown>) : DEFAULT_FILES_EXCLUDE;
      },
      workspaces,
      ask: this.ask,
      t,
      log: report,
      reveal: (absolutePath) => platform.shell.revealPath(absolutePath),
      copy: (text) => platform.clipboard.writeText(text),
      changed: (change) => this.shell?.filesChanged(change),
      ignored: (projectKey, relativeDir, entries) => this.scm?.ignored(projectKey, relativeDir, entries) ?? Promise.resolve(new Set()),
      target: (projectKey) => this.filesTarget(projectKey),
    });
    const quickOpenIndex = new QuickOpenIndex({
      projects: () => this.quickOpenRoots(),
      workspaces,
      walk: platform.walkSettings,
      excludes: () => [...fileTree.excludePatterns(), ...this.searchExcludePatterns()],
      watch: (project) => fileTree.watch(project),
      startWorker: () => new Worker(quickOpenWorkerPath(platform.paths)),
      log: report,
      authorityOs: (authority) => this.knownAuthorityOs(authority),
      spellings: this.rootSpellings,
      homedir: (authority) => (authority === 'local' ? os.homedir() : this.authorities?.connection(authority)?.facts.homedir),
      hostName: (authority) => this.hostName(authority),
    });
    const htmlPreviews = new HtmlPreviews({
      projects,
      files: (rootKey) => workspaces.forProject(rootKey).files,
      authorityOs: (authority) => this.authorityOs(authority),
      isTrusted: (project) => this.isProjectTrusted(project),
      requestTrust: (project) => this.requestProjectTrust(project).catch(this.report('Trust Project')),
      onDidSave: (listener) => documents.onDidSave(listener),
      hostName: (authority) => this.hostName(authority),
      openExternal: (url) => platform.shell.openExternal(url),
      openInBrowserFailed: () => void this.notifications.error(t('Damocles could not open the preview in the browser.')),
      changed: () => this.editorPane?.htmlPreviewsChanged(),
      createSession: (deps) => createPreviewSession(deps).ready,
      served: this.servedRoots,
      focusAway: () => this.focusAwayFromPage(),
      focusPart: (step) => this.focusPart(step),
      log: report,
    });
    const editorPane = new EditorPane({
      documents,
      htmlPreviews,
      authorityOs: (authority) => this.authorityOs(authority),
      wslDistro: (authority) => {
        const host = this.hostAuthority(authority);
        return host?.kind === 'wsl' ? host.distro : undefined;
      },
      settings: platform.settings,
      ask: this.ask,
      t,
      render: (text) => localization.render(text),
      log: report,
      restoreLayout: () => platform.settings.get<boolean>(RESTORE_LAYOUT_SETTING, true) !== false,
      persist: (editor) => this.windowLayout.setEditor(editor),
      flushBackups: () => this.backups.flush(),
      logsDir: this.logsDir,
      sendState: (state) => {
        this.shell?.editorState(state);
        this.editorRootKeys = new Set(state.tabs.flatMap((tab) => (tab.projectKey !== undefined ? [tab.projectKey] : [])));
        this.refreshScmRoots();
        this.refreshMenuState();
      },
      sendDocument: (documentId, content) => this.shell?.documentChanged(documentId, content),
      sendCommand: (command) => this.shell?.editorCommand(command),
      sendFlush: (requestId, format) => this.shell?.editorFlush(requestId, format) ?? false,
      focusTab: (tabId) => this.shell?.focusEditorTab(tabId),
      revealLine: (tabId, line, range) => this.shell?.revealEditorLine(tabId, line, range),
      showPane: () => {
        if (!this.windowLayout.sidebar().grid.visible.editor) this.toggleGridPane('editor');
      },
      hidePane: () => {
        if (this.windowLayout.sidebar().grid.visible.editor) this.toggleGridPane('editor');
      },
      showPaneBeside: () => {
        const grid = this.windowLayout.sidebar().grid;
        if (grid.maximized !== null && grid.maximized !== 'editor') this.setGrid({ ...grid, maximized: null });
        if (!this.windowLayout.sidebar().grid.visible.editor) this.toggleGridPane('editor');
      },
      projects,
      awaitsRegistry: (key) => this.roots.awaitsRegistry(key),
      worktreeBranch: (key) => this.roots.branchOf(key),
      copy: (text) => platform.clipboard.writeText(text),
      reveal: (absolutePath) => platform.shell.revealPath(absolutePath),
      mention: (target) => this.mentionInSelectedChat(target),
      browser: () => this.pageTabs,
      terminals: () => this.terminals?.tabSource,
      warn: (message) => void this.notifications.warn(message),
      error: (message) => void this.notifications.error(message),
      hostName: (authority) => this.hostName(authority),
      searchEditorClosed: (documentId) => this.search?.searchEditorClosed(documentId),
      reviewClosed: (reviewId) => this.chatReviews.reviewClosed(reviewId),
      gitOf: (location) => this.scm?.gitOf(location),
      openChanges: (location) => this.requireScm().openChangesOf(location),
      designScreens: {
        is: (location) => this.designScreenAuthority(location) !== undefined,
        preview: (location) => this.previewDesignScreen(location),
      },
    });
    // D29's errors and timeouts; Show Output opens it as a log tab (D36).
    const formatLog = this.logSinks.create('Format');
    const formatter = new FormatService({
      target: (documentId) => editorPane.formatTarget(documentId),
      projects,
      isTrusted: (project) => this.isProjectTrusted(project),
      requestTrust: (project) => {
        this.requestProjectTrust(project).catch(this.report('Trust Project'));
      },
      formatOnSave: () => editorSettings(platform.settings).formatOnSave,
      workspaces,
      notify: (severity, message, action) => {
        const actions = action ? [action.label] : [];
        const answer = severity === 'info' ? this.notifications.info(message, ...actions) : this.notifications.warn(message, ...actions);
        answer.then((chosen) => {
          if (action && chosen === action.label) action.run();
        }, this.report('A format notice'));
      },
      formatLog: { appendLine: (line) => formatLog.appendLine(line), show: () => formatLog.show(false) },
      log: report,
      t,
    });
    const search = new SearchHost({
      settings: platform.settings,
      documents,
      editorPane,
      projects,
      selectedFolder: () => this.searchFolder(),
      workspaces,
      osOf: (projectKey) => this.projectOs(projectKey),
      walk: () => platform.walkSettings.read(),
      linksNotSearched: (projectKey) => this.linksNotSearched(projectKey),
      excludeSettings: () => [...fileTree.excludePatterns(), ...this.searchExcludePatterns()],
      ask: this.ask,
      t,
      warn: (message) => void this.notifications.warn(message),
      copy: (text) => platform.clipboard.writeText(text),
      selectedText: () => editorPane.activeContext()?.selection?.text,
      showSidebar: () => this.showSidebar(),
      clearSearchHistory: () => {
        this.windowLayout.clearSearchHistory();
        this.shellStateChanged();
      },
      sendResults: (batch) => this.shell?.searchResults(batch),
      sendFileUpdate: (update) => this.shell?.searchFileUpdate(update),
      sendDone: (done) => this.shell?.searchDone(done),
      sendHighlights: (highlights) => this.shell?.searchEditorHighlights(highlights),
      sendCommand: (message) => this.shell?.searchCommand(message),
      focusSearch: (focus) => this.shell?.focusSearch(focus),
      stateChanged: () => this.refreshMenuState(),
      log: report,
      lineDelimiter: process.platform === 'win32' ? '\r\n' : '\n',
    });
    documents.onDidChangeText((change) => search.documentChanged(change.documentId));
    // Source control (AD4) runs in Damocles Core, which writes the Git log (argv, duration and exit code, redacted as it is
    // written); Show Git Output opens it as a log tab (D36).
    const git = this.gitProbe;
    const askInput = createInputAsker({
      overlay: () => this.overlay,
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      unavailable: () => void this.notifications.error(t('The text box could not be shown, so nothing was changed. Try again.')),
      log: report,
    });
    this.askCredential = createAskpassBridge({ ask: this.ask, askInput, t });
    const scmClient = createScmClient({
      core: (authority, label, work) => this.chatHost(authority).run(label, (core) => work(core.client)),
      features: (authority) => this.authorities?.connection(authority)?.features,
      gitVersion: git.available ? git.version : undefined,
      log: report,
    });
    this.scmClient = scmClient;
    const forgeHost = new ForgeHost({
      core: (label, work) => this.core.run(label, (core) => work(core.client)),
      scm: scmClient,
      features: (authority) => this.authorities?.connection(authority)?.features,
      projectName: (projectKey) => this.listedProjectName(projectKey),
      savedHost: (authority) => {
        if (this.savedHostRecord(authority) === undefined) return undefined;
        const color = this.hostColor(authority);
        return { hostName: this.hostName(authority), ...(color !== undefined ? { color } : {}) };
      },
      asker: createForgeAccountAsker({
        overlay: () => this.overlay,
        focused: () => webContents.getFocusedWebContents() ?? undefined,
        reveal: () => this.revealWindow(),
        log: report,
      }),
      openAccounts: (target) => this.openSettings({ section: 'accounts', ...(target.serverId !== undefined ? { forgeServer: target.serverId } : {}), ...(target.signIn === true ? { forgeSignIn: true } : {}) }),
      render: (text) => localization.render(text),
      openExternal: async (url) => {
        if (!(await platform.shell.openExternal(url))) throw new Error('The page could not be opened');
      },
      serverWebUrls: () => this.client()?.forgeServers()?.filter((server) => server.hasAccount).map((server) => server.webUrl),
      accountServers: () => this.client()?.forgeAccountServers(),
      showPipelinePopover: async (repoId, anchor) => {
        const overlay = this.overlay;
        if (!overlay) throw new Error('The job list has no window to show in');
        // the shell keeps focus on the chip, which gets it back when the popover closes
        await overlay.request({ kind: 'pipeline', repoId, anchor }, this.window?.webContents);
      },
      openJobLog: (repoId, jobId) => this.requireJobLogTabs().open(repoId, jobId, { focus: true }),
      writeClipboard: (text) => platform.clipboard.writeText(text),
      showClonePicker: async (request) => {
        const overlay = this.overlay;
        if (!overlay) throw new Error('The clone picker has no window to show in');
        return overlay.request(request, this.window?.webContents);
      },
      startClone: (clone) => {
        if (!this.scm) throw new Error('Source control is not ready for a clone');
        this.scm.cloneFromPicker(clone);
      },
      dialogs: {
        ask: async (request) => {
          const overlay = this.overlay;
          if (!overlay) throw new Error('The Publish and fork dialogs have no window to show in');
          this.revealWindow();
          return overlay.request(request, webContents.getFocusedWebContents() ?? this.window?.webContents);
        },
        publishState: (state) => this.overlay?.updateForgePublish(state),
        forkState: (state) => this.overlay?.updateForgeFork(state),
        protectedState: (state) => this.overlay?.updateForgeProtected(state),
      },
      notify: {
        info: (message) => void this.notifications.info(message),
        warn: async (message, action) => (await this.notifications.warn(message, action)) === action,
        error: (message) => void this.notifications.error(message),
      },
      log: report,
    });
    this.forgeHost = forgeHost;
    forgeHost.onChanged((changed) => this.shell?.forgeChanged(changed));
    forgeHost.onCiChanged((changed) => {
      this.shell?.forgeCiChanged(changed);
      this.refreshMenuState();
    });
    const jobLogTabs = new JobLogTabs({
      core: (label, work) => this.core.run(label, (core) => work(core.client)),
      coreRunning: () => this.core.current() !== undefined,
      forge: forgeHost,
      pane: editorPane,
      render: (text) => localization.render(text),
      t,
      send: (update) => this.shell?.jobLogUpdate(update),
      log: report,
    });
    this.jobLogTabs = jobLogTabs;
    const stopCiLogs = forgeHost.onCiLog((id, view) => jobLogTabs.coreLog(id, view));
    const stopRetargets = forgeHost.onJobRetargeted((repoId, jobId, newJobId) => jobLogTabs.retarget(repoId, jobId, newJobId));
    this.disposables.push(forgeHost, jobLogTabs, { dispose: stopCiLogs }, { dispose: stopRetargets });
    const scm = new ScmHost({
      forge: forgeHost,
      service: scmClient,
      remoteFileRef: (authority, targetPath) => remoteFileRef(this.remoteFileRoots(authority), targetPath),
      hostName: (authority) => this.hostName(authority),
      authorityOs: (authority) => this.authorityOs(authority),
      settings: platform.settings,
      documents,
      projects: () => this.scmRoots(),
      selectedProjectKey: () => this.searchFolder()?.projectKey,
      editorPane,
      selection: { get: (projectKey) => this.windowLayout.scmSelected(projectKey), set: (projectKey, root) => this.windowLayout.setScmSelected(projectKey, root) },
      notify: this.notifications,
      t,
      render: (text) => localization.render(text),
      showGitLog: () => {
        const authority = authorityKeyOfProject(this.selectedProjectKey ?? '');
        if (authority === 'local') this.openLogTab(path.join(this.logsDir, logFileName('Git')), false);
        else this.showRemoteLog(authority, logFileName('Git'), false).catch(this.report('Show Git Output'));
      },
      // the host's kind, OS and switch from this computer's host store
      agentForwarding: (authority) => {
        const hostId = this.savedHostIdOf(authority);
        const record = hostId === undefined ? undefined : this.hostStore?.host(hostId);
        if (!record || !offersAgentForwarding(record)) return undefined;
        return { hostName: record.name, enable: () => this.requireRemoteHosts().setSetting(record.id, { key: 'forwardAgent', value: true }) };
      },
      copy: (text) => platform.clipboard.writeText(text),
      reveal: (absolutePath) => platform.shell.revealPath(absolutePath),
      openExternal: async (url) => {
        if (!(await platform.shell.openExternal(url))) throw new Error('The link could not be opened');
      },
      pickFolder: (defaultPath, title, buttonLabel) => platform.nativeDialogs.pickFolder({ title: title ?? t('Open Repository'), defaultPath, ...(buttonLabel !== undefined ? { buttonLabel } : {}) }),
      addProject: async (authority, folder) => {
        if (authority === 'local') await this.addProjectAt(folder);
        else await this.addRemoteProject(authority, folder);
      },
      // Source Control's Open Worktree, the user's
      selectProject: (projectKey) => this.selectProject(projectKey, true),
      worktrees: this.scmWorktreeDeps(),
      gitFound: git.available,
      quickPick: createQuickPickAsker({
        overlay: () => this.overlay,
        focused: () => webContents.getFocusedWebContents() ?? undefined,
        unavailable: () => void this.notifications.error(t('The list could not be shown, so nothing was changed. Try again.')),
        tooLarge: () => void this.notifications.error(t('The list has too many entries to show, so nothing was changed.')),
        log: report,
      }),
      ask: this.ask,
      askInput,
      mention: (target) => this.mentionInSelectedChat(target),
      addToChat: (projectKey, attachment, prompt) => this.addAttachmentToChat(projectKey, attachment, t('The chat could not be loaded, so the commit was not added to it.'), prompt),
      send: {
        view: (view) => this.shell?.scmView(view),
        state: (snapshot) => this.shell?.scmState(snapshot),
        decorations: (decorations) => this.shell?.scmDecorations(decorations),
        settings: (settings) => this.shell?.scmSettings(settings),
        command: (command) => this.shell?.scmCommand(command),
        setInput: (input) => this.shell?.scmSetInput(input),
        clone: (state) => this.shell?.scmClone(state),
        artifactsChanged: (changed) => this.shell?.scmArtifactsChanged(changed),
        filesChanged: (projectKey) => this.shell?.filesChanged({ projectKey, relativeDirs: [] }),
      },
      menuChanged: () => this.refreshMenuState(),
      log: report,
      platform: process.platform,
    });
    this.scm = scm;
    // the list each core receives as it attaches (ScmClient)
    scm.setProjects(this.scmRoots());
    this.disposables.push(scm, scmClient);

    this.palette = new CommandPalette({
      commands: () => desktopCommands(this.orderedLocalFolders(), this.menuActions(), process.platform),
      l10n: localization,
      english: createDesktopLocalizationService(resourceRoot, 'en', report),
      platform: process.platform,
      log: report,
    });
    this.disposables.push(fileTree.onDidChangeStructure((projectKey) => {
      quickOpenIndex.invalidate(projectKey);
      this.devcontainerConfigs.refresh([projectKey]);
    }), quickOpenIndex, fileTree, editorPane, htmlPreviews, documents, search, workspaces, formatLog);
    this.htmlPreviews = htmlPreviews;
    this.formatter = formatter;
    this.search = search;
    this.fileTree = fileTree;
    this.startFileTransfers(platform, t, projects, workspaces, editorPane);
    this.documents = documents;
    this.quickOpenIndex = quickOpenIndex;
    this.editorPane = editorPane;
    // Playwright drives the agent's side of EditorService (openFile, showDiff without approvalId), raises host prompts and modal
    // questions, stores their answers as secrets, routes the browser's requests and makes Files' trash or permanent delete fail
    // through this, in the unpackaged app only. What reaches the engine goes through core's e2e.* requests.
    if (E2E_HOOKS) {
      const e2eFinishHolds = new Map<string, FinishHold>();
      const hooks = {
        editor: platform.editor,
        dialogs: { inputBox: (options: InputBoxOptions) => this.requireCore().client.e2eInputBox(options) },
        // core's capabilities read this platform until the next core starts; null restores the real one, which is returned
        setCorePlatform: (next: NodeJS.Platform | null) => this.core.run('e2e', (core) => core.client.e2eSetPlatform(next)),
        // core's renames to a file of this name wait delayMs from now on, and how many waited (core's writeJsonConfig)
        slowCoreRenames: (basename: string, delayMs: number) => this.core.run('e2e', (core) => core.client.e2eSlowRenames(basename, delayMs)),
        slowedCoreRenames: (basename: string) => this.core.run('e2e', (core) => core.client.e2eSlowedRenames(basename)),
        // core's next core.shutdown never answers, so the quit's bound kills core
        holdCoreShutdown: () => this.core.run('e2e', (core) => core.client.e2eHoldShutdown()),
        // the paths core's recursive watch of folder reported created, starting it on the first call
        watchCoreProbe: (folder: string) => this.core.run('e2e', (core) => core.client.e2eWatchProbe(folder)),
        stopCoreWatchProbe: (folder: string) => this.core.run('e2e', (core) => core.client.e2eStopWatchProbe(folder)),
        // this computer's core signs in to the stub OAuth account; remote chats get its tokens through the broker
        stubOAuth: (account: string, expiresInMs: number, offline?: boolean) => this.core.run('e2e', (core) => core.client.e2eStubOAuth(account, expiresInMs, offline)),
        notifications: platform.notifications,
        // main took an overlay request of this kind and keeps it unsent, behind a question or a page load
        overlayWaiting: (kind: OverlayRequest['kind']) => this.overlay?.isWaiting(kind) ?? false,
        secrets: platform.secrets,
        // requests of the active page's browser context whose URL matches pattern load from toHost instead; routed lists them
        browser: {
          // a remote host's browser proxy answers these names from the list, in turn (a name that rebinds)
          clientNetworkAnswers: (answers: Record<string, string[][]>) => this.requireCore().client.e2eClientNetworkAnswers(answers),
          route: (pattern: string, toHost: string) => this.requireCore().client.e2eRouteBrowser(pattern, toHost),
          routed: () => this.requireCore().client.e2eRoutedRequests(),
        },
        // counts the browser page restores main asks core for, from now on
        countPageRestores: () => {
          this.e2ePageRestores = { count: 0 };
          return this.e2ePageRestores;
        },
        launchTabsOpened: () => this.launchTabs,
        failFiles: (failure: { readonly trash?: string; readonly remove?: string }) => {
          if (failure.trash !== undefined) this.trashEntry = () => Promise.reject(new Error(failure.trash));
          if (failure.remove !== undefined) this.removeEntry = () => Promise.reject(new Error(failure.remove));
        },
        // reached turns true once a quit waits on the hold
        holdStoreFlush: () => {
          const hold = { reached: false, release: (): void => undefined };
          const released = new Promise<void>((resolve) => (hold.release = resolve));
          this.beforeStoreFlush = () => {
            hold.reached = true;
            return released;
          };
          return hold;
        },
        // reached turns true once a core dispose waits on the hold
        holdCoreDispose: () => {
          const hold = { reached: false, release: (): void => undefined };
          const released = new Promise<void>((resolve) => (hold.release = resolve));
          this.beforeCoreDispose = () => {
            hold.reached = true;
            return released;
          };
          return hold;
        },
        // Saved SSH hosts: seeding without the Connect dialog, a host's live control channel (the teardown's shutdownNow),
        // its attempt and its logs.
        remote: {
          // the authority's core's sessions step pauses (or hangs, holding its lock) after this many chats moved; null clears it
          relocationPauseAfter: (authorityKey: string, sessions: number | null, mode: 'pause' | 'hang') => this.chatHost(authorityKey).run('E2E relocation', (core) => core.client.e2eRelocationPauseAfter(sessions, mode)),
          // the no-dialog keep path an OS shutdown or an update's quit takes, then the quit
          simulateShutdown: (kind: 'os' | 'quitAndInstall') => this.quitUnattended(kind === 'os' ? 'the e2e hooks shut the system down' : 'the e2e hooks install an update'),
          hosts: () => this.requireHostStore().hosts().map((record) => ({
            hostId: record.id,
            name: record.name,
            ...(record.kind === 'wsl' ? { distro: record.distro } : record.kind === 'container' ? { container: record.key, ...(record.containerId !== undefined ? { containerId: record.containerId } : {}) } : record.destination.kind === 'alias' ? { alias: record.destination.alias } : { host: record.destination.host, ...(record.destination.user !== undefined ? { user: record.destination.user } : {}), ...(record.destination.port !== undefined ? { port: record.destination.port } : {}) }),
            authorityKey: this.authorityOfHost(record.id),
            connection: this.requireRemoteHosts().connectionOf(record.id),
          })),
          state: (hostId: string) => this.requireRemoteHosts().connectionOf(hostId),
          connectStep: (hostId: string) => this.requireRemoteConnections().attempt(hostId),
          // shutdownNow and handOver now settle once the daemon ended this connection, as the app's own switch does, so nothing the
          // spec does next reaches a daemon stopping
          control: async (hostId: string, command: keyof ClientToControl['requests'], params: object) => {
            if (command === 'shutdownNow') return this.shutDownDaemon(this.authorityOfHost(hostId));
            const connection = this.requireConnection(this.authorityOfHost(hostId));
            if (command === 'handOver' && (params as { readonly when?: unknown }).when === 'now') return handOverNow(connection, (line) => log(line));
            return (connection.control as unknown as { request(name: string, params: object): Promise<unknown> }).request(command, params);
          },
          dropConnection: (hostId: string) => this.authorities?.connection(this.authorityOfHost(hostId))?.close('the e2e hooks dropped it'),
          // Damocles' master connection, which macOS and Linux keep for ControlPersist after its daemon and sessions ended
          exitControlMaster: (hostId: string) => this.exitHostControlMaster(hostId),
          // the transport alone goes, as a network drop does; hold: every attempt's transport fails until releaseTransport
          cutTransport: (hostId: string, options?: { readonly hold?: boolean }) => this.cutTransport(this.authorityOfHost(hostId), options?.hold === true),
          releaseTransport: (hostId: string) => this.heldTransports.delete(this.authorityOfHost(hostId)),
          reconnectPhase: (authorityKey: string) => this.reconnector?.phase(authorityKey),
          reconnectNow: (authorityKey: string) => this.reconnector?.reconnectNow(authorityKey, true),
          latency: (authorityKey: string) => this.latency?.latency(authorityKey),
          // the picker a remote core's dialogs.pickFile or dialogs.pickFolder opens, answered as core would be
          pick: (authorityKey: string, kind: 'file' | 'folder', { title, ...options }: { readonly title?: string; readonly defaultPath?: string; readonly buttonLabel?: string }) => {
            const { dialogs } = this.remoteServicesOf(authorityKey, this.authorities?.connection(authorityKey)?.features ?? []).platform;
            const named = { ...options, ...(title !== undefined ? { title: verbatim(title) } : {}) };
            const { buttonLabel, ...file } = named;
            return kind === 'file' ? dialogs.pickFile(file) : dialogs.pickFolder({ ...file, ...(buttonLabel !== undefined ? { buttonLabel: verbatim(buttonLabel) } : {}) });
          },
          addHost: async (target: { readonly alias: string; readonly name: string } | { readonly input: string; readonly name: string }) => {
            const destination = 'alias' in target ? { kind: 'alias' as const, alias: target.alias } : (() => {
              const parsed = parseSshCommand(target.input);
              if (!parsed.ok) throw new Error(`refused: ${parsed.refused}`);
              return parsed.destination;
            })();
            const added = await this.requireHostStore().addHost({ destination, name: target.name });
            if (!added.ok) throw new Error(`name refused: ${added.check.ok ? '' : added.check.reason}`);
            return added.host.id;
          },
          // a listed WSL distro's host record, made as its first connect makes it
          addDistro: async (distro: string) => {
            const record = await this.requireRemoteHosts().distroHost(distro);
            if (!record) throw new Error(`wsl.exe lists no distro ${distro}`);
            return record.id;
          },
          // connects with no prompt answered (a prompt fails the attempt), then adds the folder and selects it
          openFolder: async (hostId: string, folder: string, trust: boolean, deadlineMs: number) => {
            const authority = this.authorityOfHost(hostId);
            await waitForRemoteFolderConnection(this.requireRemoteConnections(), this.requireAuthorities(), hostId, authority, deadlineMs);
            if (trust) {
              const folderKey = await this.requireConnection(authority).workspace.request('files.folderKey', { path: folder });
              await this.requireHostStore().grantTrust(authority, folderKey);
            }
            return this.addRemoteProject(authority, folder);
          },
          setInstallFolder: (hostId: string, folder: string | null) => this.requireRemoteHosts().setInstallFolder(hostId, folder),
          // a project file's bytes through its host's workspace over the wire, for the binary transparency checks
          readBytes: async (projectKey: string, relativePath: string) => {
            const project = this.remoteProject(projectKey);
            if (!project) throw new Error(`${projectKey} is not a remote project`);
            const files = this.remoteWorkspace(project.authorityKey).files;
            const confined = await files.confineExisting(project, relativePath, 'throughLinks');
            if (!confined.ok) throw new Error(`${relativePath} is ${confined.reason}`);
            const read = await files.read(confined.path, 64 * 1024 * 1024);
            if (read.kind !== 'bytes') throw new Error(`${relativePath} reads as ${read.kind}`);
            return read.bytes.toString('base64');
          },
          writeBytes: async (projectKey: string, relativePath: string, base64: string) => {
            const project = this.remoteProject(projectKey);
            if (!project) throw new Error(`${projectKey} is not a remote project`);
            const files = this.remoteWorkspace(project.authorityKey).files;
            const confined = await files.confineMissing(project, relativePath, 'throughLinks');
            if (!confined.ok) throw new Error(`${relativePath} is ${confined.reason}`);
            await files.writeInPlace(project, { path: confined.path, projectKey, relativePath }, Buffer.from(base64, 'base64'));
          },
          logs: async (hostId: string) => {
            const connection = this.authorities?.connection(this.authorityOfHost(hostId));
            let daemon = '';
            if (connection) {
              const { logs } = await connection.control.request('logs.list', {});
              const entry = logs.find((candidate) => candidate.name === DAEMON_LOG);
              if (entry) {
                const length = Math.min(entry.size, MAX_LOG_READ_BYTES);
                daemon = Buffer.from((await connection.control.request('logs.read', { name: DAEMON_LOG, offset: entry.size - length, length })).bytes).toString('utf8');
              }
            }
            return { daemon, bridgeStderr: this.requireRemoteConnections().stderrTail(hostId) };
          },
        },
        // The loopback daemon: open a folder through it without the native picker, and its frozen control commands.
        loopback: {
          openFolder: (folder: string) => this.addLoopbackProject(folder),
          state: () => this.authorities?.state('loopback') ?? 'offline',
          listRuns: () => this.loopbackControl().request('listRuns', {}),
          // ends the connection for good; selecting a loopback project connects again
          dropConnection: () => this.authorities?.connection('loopback')?.close('the e2e hooks dropped it'),
          // the transport alone goes, as a network drop does; hold: every attempt's transport fails until releaseTransport
          cutTransport: (options?: { readonly hold?: boolean }) => this.cutTransport('loopback', options?.hold === true),
          releaseTransport: () => this.heldTransports.delete('loopback'),
          shutdownNow: () => this.shutDownDaemon('loopback'),
          coreState: () => this.loopbackControl().request('coreState', {}),
          // the generation the open settings modal's messages carry, which a spec sends a settings request with
          settingsGeneration: () => this.overlaySettings?.attachedGeneration(),
          // reached turns true once a settings tab's attach waits on the hold; release lets it and every later one go on,
          // fail makes them find no chat, until the next hold
          holdSettingsAttach: () => {
            const hold = { reached: false, release: (): void => undefined, fail: (): void => undefined };
            const released = new Promise<void>((resolve, reject) => {
              hold.release = resolve;
              hold.fail = () => reject(new Error('the e2e hooks failed the settings attach'));
            });
            released.catch(() => undefined);
            this.beforeSettingsTarget = () => {
              hold.reached = true;
              return released;
            };
            return hold;
          },
          // the epoch main's chats are open under, and the state main last heard of
          engine: () => ({ epoch: this.remoteCores.get('loopback')?.epoch() ?? null, state: this.engines().find((engine) => engine.authority === 'loopback')?.state ?? null }),
        },
        // Source control: the sub-call ledger path and the Git log as written.
        scm: {
          // one autofetch round of the selected project now, as if the period had elapsed
          autofetchNow: () => this.requireScm().autofetchNow(),
          ledgerPath: () => SUBCALL_USAGE_LEDGER_PATH,
          gitLog: () => fs.promises.readFile(path.join(this.logsDir, logFileName('Git')), 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? '' : Promise.reject(err))),
          // reached turns true once a Graph history request waits on the hold; release answers it and every later one, fail
          // rejects them, until the next hold
          holdHistory: () => {
            const hold = { reached: false, release: (): void => undefined, fail: (): void => undefined };
            const released = new Promise<void>((resolve, reject) => {
              hold.release = resolve;
              hold.fail = () => reject(new Error('the e2e hooks failed the history read'));
            });
            // a hold failed before any request waits on it is not an unhandled rejection
            released.catch(() => undefined);
            this.beforeHistory = () => {
              hold.reached = true;
              return released;
            };
            return hold;
          },
        },
        reloadCore: () => this.core.reload(),
        // core's sessions step pauses (or hangs, holding its lock) after this many chats moved; null clears it
        relocationPauseAfter: (sessions: number | null, mode: 'pause' | 'hang') => this.core.run('E2E relocation', (core) => core.client.e2eRelocationPauseAfter(sessions, mode)),
        // the folder chats open in when none is named, as main's mirror of core's folder targets holds it now
        defaultProjectKey: () => this.client()?.defaultTarget()?.key,
        // every theme blob answer since launch: a media element reads a video in byte ranges
        themeBlobResponses: () => [...this.servedThemeBlobs],
        themeStore: {
          // the updater's own store check, under its "Check for updates automatically" switch; only the packaged gate is skipped
          backgroundCheck: () => this.requireUpdates().checkStore(),
          // every request the community store made since the last call
          fetches: async () => (await this.core.run('e2e', (core) => core.client.e2eThemeStoreFetches())).fetches,
        },
        // an e2e window may never get focus from the OS, and its machine may run on battery; what is pinned here holds
        pinMotion: (pinned: Parameters<typeof setMotionEnvironment>[0]) => {
          this.pinnedMotion = { ...this.pinnedMotion, ...pinned };
          this.motionChanged({});
        },
        // the keep-changes countdown: after hold() no countdown ends by the clock, and expire() ends the running one as its
        // timeout does (false when none waits)
        keepChanges: {
          hold: () => this.keepChangesTimers?.hold(KEEP_CHANGES_MS),
          expire: () => (this.keepChangesTimers?.fire() ?? 0) > 0,
        },
        // a draft capture's wait for its pages' paint: after hold() it ends only when they painted or the capture stopped
        themeAcks: {
          hold: () => this.themeAckTimers?.hold(THEME_APPLIED_TIMEOUT_MS),
        },
        // the screenshot notice: after hold() none closes by the clock, whatever time it has left; raised() lists every
        // notice raised since launch, a capture of a chat the notice already shows included
        screenshotNotice: {
          hold: () => this.screenshotNoticeTimers?.hold(0),
          raised: () => [...this.raisedScreenshotNotices],
        },
        // main's schedule clock reads `now` from this call on and runs on from there, and main's own THEME_TICK_MS tick
        // stops, so nothing evaluates the schedule again but an input change, a power event or themeTick(); null gives back
        // Date.now and the tick
        themeClock: (now: number | null) => {
          const setAt = Date.now();
          this.themeTickHeld = now !== null;
          setThemeClock(now === null ? undefined : () => now + (Date.now() - setAt));
        },
        themeTick: () => reevaluateTheme(),
        // stands in for the computer's light or dark mode; null gives the OS's back
        themeOsKind: (kind: 'dark' | 'light' | null) => setOsKindStandIn(kind ?? undefined),
        // the accent and palettes System colors reads in place of this computer's; null gives the computer's back
        systemColors: (set: SystemColors | null) => this.systemColors.override(set ?? undefined),
        // the GPU compositing status once the GPU process has reported
        gpuCompositing: async () => {
          await E2E_GPU_REPORTED;
          return app.getGPUFeatureStatus().gpu_compositing;
        },
        // the regional format the schedule screen is told, in place of the machine's; null gives the machine's back
        themeSystemLocale: (locale: string | null) => {
          this.pinnedSystemLocale = locale ?? undefined;
        },
        // what the window shows without a transient preview, nativeTheme.themeSource and the zone schedules use
        themeShown: () => {
          const shown = currentBaseShown();
          return { themeId: shown.themeId, kind: shown.kind, decidedBy: shown.decidedBy, until: shown.until, touches: shown.touches, themeSource: nativeTheme.themeSource, zone: currentScheduleView().zone };
        },
        // this computer's core records a remote chat's voice: a stand-in recorder with a fixed transcript, and its starts
        voice: {
          fake: (transcript: string) => this.core.run('E2E voice', (core) => core.client.e2eFakeVoice(transcript)),
          recorder: () => this.core.run('E2E voice', (core) => core.client.e2eVoiceRecorder()),
        },
        // the worktree dialogs (slice 12a) asked as main asks them, for the captures
        worktrees: {
          ask: (dialog: WorktreeDialog) => {
            if (!this.askWorktreeDialog) throw new Error('Worktrees are not started');
            return this.askWorktreeDialog(dialog);
          },
          // a finish action's hold on this computer's core, kept until released; false when core gave none
          holdFinish: async (worktreeId: string) => {
            const hold = await this.core.run('E2E finish hold', (core) => core.client.beginWorktreeFinish(worktreeId, 'apply', () => false));
            if (hold) e2eFinishHolds.set(worktreeId, hold);
            return hold !== undefined;
          },
          releaseFinish: async (worktreeId: string) => {
            const hold = e2eFinishHolds.get(worktreeId);
            e2eFinishHolds.delete(worktreeId);
            await hold?.release();
          },
        },
        // reached turns true once a chat restore waits on the hold; fail makes every held restore reject
        holdChatRestore: () => {
          const hold = { reached: false, release: (): void => undefined, fail: (): void => undefined };
          const released = new Promise<void>((resolve, reject) => {
            hold.release = resolve;
            hold.fail = () => reject(new Error('the e2e hooks failed the chat restore'));
          });
          this.beforeChatRestore = () => {
            hold.reached = true;
            return released;
          };
          return hold;
        },
      };
      // DAMOCLES_E2E_HOLD_CHAT_RESTORE=1 holds the chat restores from launch on, before a test can call holdChatRestore.
      const launchRestore = process.env['DAMOCLES_E2E_HOLD_CHAT_RESTORE'] === '1' ? hooks.holdChatRestore() : undefined;
      (globalThis as { __damoclesE2e?: unknown }).__damoclesE2e = { ...hooks, launchRestore };
    }
  }

  private requireHtmlPreviews(): HtmlPreviews {
    if (!this.htmlPreviews) throw new Error('HTML previews used before startup finished');
    return this.htmlPreviews;
  }

  private requireDesignPreviews(): DesignPreviews {
    if (!this.designPreviews) throw new Error('Design previews used with no window open');
    return this.designPreviews;
  }

  // The window's design preview tabs (PD-7, PD-31, PD-33); the design-preview session and main's server are built once per run.
  private createDesignPreviews(window: BrowserWindow, retainingStates: () => boolean, onRestack: () => void): DesignPreviews {
    const sessionReady = this.designSession();
    this.designServer ??= new DesignServer({
      read: (target, relPath) => this.designRead(target, relPath),
      openExternal: (url) => this.requirePlatform().shell.openExternal(url),
    });
    const server = this.designServer;
    return new DesignPreviews({
      editor: this.requireEditorPane(),
      window: { isDestroyed: () => window.isDestroyed(), getContentBounds: () => window.getContentBounds(), contentView: window.contentView },
      onRestack,
      support: (authority) => this.designSupport(authority),
      info: (target, relPath) => this.requireDesignClient(target.authority).designInfo(target.designId, relPath),
      setTabs: (chatPanelId, tabs) => this.states.setDesignTabs(chatPanelId, tabs),
      retainingStates,
      hostName: (authority) => (authority === 'local' ? undefined : this.hostName(authority)),
      openInBrowser: (target, relPath) => server.open(target, relPath),
      revoke: (target) => server.revoke(target),
      copy: (text) => this.requirePlatform().clipboard.writeText(text),
      mention: (chat, filePath) => this.mentionDesignFile(chat, filePath),
      openInBrowserFailed: () => void this.notifications.error(this.requireLocalization().t('Damocles could not open the design in the browser.')),
      focusAway: () => this.focusAwayFromPage(),
      focusPart: (step) => this.focusPart(step),
      log: (line) => log(line),
      sessionReady,
      replayProgress: (progress) => this.shell?.designReplayProgress(progress),
      tabClosed: (tabId) => this.shell?.designPreviewClosed(tabId),
    });
  }

  // The preview's Send to designer, a user's click (PD-12): the flattened markup, fitted for the model (PD-41), goes to the
  // tab's design chat on that chat's own core, which validates it, writes its files and sends it. A refusal is a toast, and
  // keeps markup on so the marks can be sent again.
  private async designMarkupSend(request: DesignMarkupSendRequest): Promise<DesignMarkupSent> {
    const { t, render } = this.requireLocalization();
    const chat = this.requireDesignPreviews().chatOfTab(request.tabId);
    const panel = this.views?.panel(chat.panelId);
    if (!panel || panel.kind !== 'chat') return this.refuseWithToast(t('The design chat is not loaded, so the markup was not sent.'));
    if (panel.authority !== 'local' && !this.authorities?.connection(panel.authority)?.features?.includes('design.markup')) {
      return this.refuseWithToast(t('Update the Damocles server on this host to send markup.'));
    }
    let png: string;
    try {
      png = markupPngForModel(request.png);
    } catch (err) {
      log(`[design] the markup image was refused: ${err instanceof Error ? err.message : String(err)}`);
      return this.refuseWithToast(t('The markup image could not be prepared, so it was not sent.'));
    }
    const outcome = await this.chatHost(panel.authority).run('Markup', async (core) => {
      const corePanelId = (await this.restoredCorePanel(panel)).corePanelId;
      if (corePanelId === undefined) return undefined;
      return core.client.designMarkup(corePanelId, png, request.json);
    });
    if (!outcome) return this.refuseWithToast(t('The design chat is not loaded, so the markup was not sent.'));
    if ('refused' in outcome) return this.refuseWithToast(render(outcome.refused));
    // Main ends markup itself: the user may have selected another chat meanwhile, and the shell drops its marks on this answer.
    this.designPreviews?.markupExit(request.tabId);
    return outcome;
  }

  // The Tweaks column's Keep, a user's click (PD-13): the tweak goes to the tab's design chat on that chat's own core, which checks
  // it against its latest DeclareTweaks and sends it as its own prompt. A refusal is a toast.
  private async designTweakKeep(request: DesignTweakKeepRequest): Promise<void> {
    const { t, render } = this.requireLocalization();
    const chat = this.requireDesignPreviews().chatOfTab(request.tabId);
    const panel = this.views?.panel(chat.panelId);
    if (!panel || panel.kind !== 'chat') return this.refuseWithToast(t('The design chat is not loaded, so the tweak was not kept.'));
    if (panel.authority !== 'local' && !this.authorities?.connection(panel.authority)?.features?.includes('design.tweak')) {
      return this.refuseWithToast(t('Update the Damocles server on this host to keep tweaks.'));
    }
    const outcome = await this.chatHost(panel.authority).run('Keep tweak', async (core) => {
      const corePanelId = (await this.restoredCorePanel(panel)).corePanelId;
      if (corePanelId === undefined) return undefined;
      return core.client.designTweak(corePanelId, request.tweakId, request.value);
    });
    if (!outcome) return this.refuseWithToast(t('The design chat is not loaded, so the tweak was not kept.'));
    if ('refused' in outcome) this.refuseWithToast(render(outcome.refused));
  }

  // The preview toolbar's Screenshot, a user's click: the live view's frame lands in its design chat's composer, marked as the
  // preview's (PD-40), straight from main to that chat's page.
  private async designScreenshot(tabId: string): Promise<void> {
    const { chat, image } = await this.requireDesignPreviews().screenshot(tabId);
    const panel = this.views?.panel(chat.panelId);
    if (!panel || panel.kind !== 'chat') throw new Error('The design chat is not loaded');
    const message: ExtensionToWebviewMessage = { type: 'composerAddImage', image, origin: 'designPreview' };
    if (!(await panel.postMessage(message))) throw new Error('The design chat could not take the image');
  }

  // The design-preview session, built once per run: preview views and render windows load only through it.
  private designSession(): Promise<void> {
    if (!this.designSessionReady) {
      const deps = { targetOf: (token: string) => this.designPreviews?.targetOf(token), read: (target: DesignViewTarget, relPath: string) => this.designRead(target, relPath), log: (line: string) => log(line) };
      this.designSessionReady = createDesignSession((request) => serveDesignRequest(request, deps)).ready;
      // each view and render refuses to load on a failure; this line names it once
      this.designSessionReady.catch((err: unknown) => log(`[design] the preview session's proxy could not be set: ${err instanceof Error ? err.message : String(err)}`));
    }
    return this.designSessionReady;
  }

  // design.capture, design.render and design.probe from the authority's core (PD-41): its own design only, read through its design.read.
  private designRenderFor(authority: string): HostServicesDeps['designRender'] {
    const runner = (): DesignRunner => {
      // a run's page lives in the design renderer process, which asks main for each design byte as the preview does
      this.designRenderer ??= new DesignRendererHost({
        start: () => startDesignRenderer(__filename, (line) => log(line)),
        read: (method, url) => serveDesignRequest({ method, url }, { targetOf: (token) => this.designRunner?.targetOf(token), read: (target, relPath) => this.designRead(target, relPath), log: (line) => log(line) }),
        log: (line) => log(line),
      });
      const host = this.designRenderer;
      this.designRunner ??= new DesignRunner({ openPage: (origin, width, events) => host.openPage(origin, width, events), log: (line) => log(line) });
      return this.designRunner;
    };
    const target = (designId: string, relPath: string): DesignViewTarget => designTargetOf(authority, designId, relPath, 'page');
    return {
      capture: ({ designId, relPath, width, state, scale }, signal) => runner().capture(target(designId, relPath), { relPath, width, state, scale }, signal),
      render: ({ designId, relPath, ...request }, signal) => runner().render(target(designId, relPath), { relPath, ...request }, signal),
      probe: ({ designId, relPath, widths, state, sweepTo }, signal) => runner().probe(target(designId, relPath), { relPath, widths, state, ...(sweepTo !== undefined ? { sweepTo } : {}) }, signal),
      journey: ({ designId, relPath, widths, state, steps, outline }, signal) => runner().journey(target(designId, relPath), { relPath, widths, state, steps, outline: outline === true }, signal),
      replay: ({ panelId, designId, relPath, state, steps, reducedMotion }, signal) => this.replayDesignJourney(authority, panelId, { designId, relPath, state, steps, reducedMotion }, signal),
    };
  }

  // design.replayJourney from a core: only the live preview of a screen of its own loaded design chat (D93), with the steps
  // validated again here, since a remote core is another trust domain.
  private async replayDesignJourney(authority: string, corePanelId: string, request: { readonly designId: string; readonly relPath: string; readonly state: string | null; readonly steps: readonly JourneyStep[]; readonly reducedMotion: boolean }, signal: AbortSignal): Promise<void> {
    const { designId, relPath } = request;
    designTargetOf(authority, designId, relPath, 'screen');
    const parsed = parseJourneySteps(request.steps);
    if (!('steps' in parsed)) throw new Error('Not journey steps');
    const chat = this.panelOfCore(chatKey(authority, corePanelId));
    if (!chat || chat.kind !== 'chat') throw new Error('The design chat is not loaded');
    if (!this.designPreviews) throw new Error('No window shows design previews');
    await this.designPreviews.replayJourney(chat, designId, relPath, request.state, parsed.steps, request.reducedMotion, signal);
  }

  // design.read and design.info exist on a daemon that names them (an older server shows its update message instead).
  private designSupport(authority: string): DesignSupport {
    if (!this.clientFor(authority)) return 'offline';
    if (authority === 'local') return 'yes';
    const features = this.authorities?.connection(authority)?.features;
    if (!features) return 'offline';
    return DESIGN_PREVIEW_FEATURES.every((feature) => features.includes(feature)) ? 'yes' : 'updateServer';
  }

  private requireDesignClient(authority: string): CoreClient {
    const support = this.designSupport(authority);
    if (support !== 'yes') throw new Error(support === 'offline' ? `The core of ${authority} is not connected` : `The server of ${authority} cannot serve designs`);
    return this.clientFor(authority)!;
  }

  // Every design byte main serves, in the preview or the browser, comes from the chat's own core.
  private designRead(target: DesignViewTarget, relPath: string): Promise<DesignPreviewFile | 'tooLarge' | undefined> {
    return this.requireDesignClient(target.authority).designRead(target.designId, relPath);
  }

  private designScreenAuthority(location: Location): string | undefined {
    return designScreenAuthority(location, {
      features: (authority) => this.authorities?.connection(authority)?.features,
      osOf: (authority) => this.knownAuthorityOs(authority),
    });
  }

  // An editor tab's Open preview on a design's screen, a user's click: the screen's own core opens it in its design chat.
  private async previewDesignScreen(location: Location): Promise<void> {
    const localization = this.requireLocalization();
    const authority = authorityOfLocation(location);
    const client = this.designScreenAuthority(location) === undefined ? undefined : this.clientFor(authority);
    if (!client) {
      void this.notifications.warn(authority === 'local'
        ? localization.t("Opening a design preview needs this computer's Damocles engine, which is not running. Restart the engine, then try again.")
        : this.authorities?.connection(authority)
          ? localization.t("Opening a design preview needs {0}'s Damocles engine, which is not running. Restart the engine, then try again.", visibleText(this.hostName(authority)))
          : localization.t('{0} is not connected.', visibleText(this.hostName(authority))));
      return;
    }
    const name = visibleText(pathFor({ os: this.knownAuthorityOs(authority) ?? process.platform }).basename(location.path));
    try {
      const outcome = await client.designPreviewScreen(location.path);
      // a remote core's text reaches the toast through main, which shows no control or direction character of it
      if ('refused' in outcome) void this.notifications.warn(visibleText(localization.render(outcome.refused)));
    } catch (err) {
      log(`[design] previewing ${location.path} failed: ${err instanceof Error ? err.message : String(err)}`);
      void this.notifications.warn(localization.t('Could not preview {0}: {1}', name, visibleText(err instanceof Error ? err.message : String(err))));
    }
  }

  // design.openPreview from a core: the tab of its design chat, never a browser (PD-35); the chat must be one of that core's.
  private openDesignPreview(authority: string, corePanelId: string, designId: string, relPath: string): void {
    designTargetOf(authority, designId, relPath, 'file');
    const chat = this.panelOfCore(chatKey(authority, corePanelId));
    if (!chat || chat.kind !== 'chat') throw new Error('The design chat is not loaded');
    if (!this.designPreviews) {
      log(`[design] no window to preview design ${designId} in`);
      return;
    }
    this.designPreviews.open(chat, designId, relPath);
  }

  // A preview tab's @: the screen's real path, as its own core's design.info named it, so on the design chat's authority.
  private async mentionDesignFile(chat: { readonly panelId: string; readonly authority: string }, filePath: string): Promise<void> {
    const panel = this.views?.panel(chat.panelId);
    if (!panel) throw new Error('The design chat is not loaded');
    await this.chatHost(panel.authority).run('Mention', async (core) => {
      const corePanelId = (await this.restoredCorePanel(panel)).corePanelId;
      if (corePanelId === undefined) throw new Error('The design chat is not loaded');
      await core.client.mention(corePanelId, { path: filePath, authority: panel.authority });
    });
  }

  private requireEditorPane(): EditorPane {
    if (!this.editorPane) throw new Error('The editor pane used before startup finished');
    return this.editorPane;
  }

  private requireFormatter(): FormatService {
    if (!this.formatter) throw new Error('Formatting used before startup finished');
    return this.formatter;
  }

  private requireFileTree(): FileTree {
    if (!this.fileTree) throw new Error('Files used before startup finished');
    return this.fileTree;
  }

  private requireTransferGestures(): TransferGestures {
    if (!this.transferGestures) throw new Error('Files used before startup finished');
    return this.transferGestures;
  }

  private requireFileTransfers(): FileTransferService {
    if (!this.fileTransfers) throw new Error('Files used before startup finished');
    return this.fileTransfers;
  }

  // Files' transfers: copies in, moves, and downloads from remote projects (docs/invariants.md "File transfers")
  private startFileTransfers(platform: DesktopPlatform, t: (message: string, ...args: Array<string | number>) => string, projects: () => readonly Project[], workspaces: Workspaces, editorPane: EditorPane): void {
    const report = (line: string): void => log(line);
    const projectKeyOfRoot = (key: string): string => parseRootKey(key)?.projectKey ?? key;
    const notify = (severity: 'info' | 'warning' | 'error', message: string, actions: readonly string[] = []): Promise<number | undefined> =>
      this.notificationCenter.notice(severity, message, actions);
    const transfers = new FileTransferService({
      projects,
      filesOf: (projectKey) => workspaces.forProject(projectKey).files,
      target: (projectKey) => this.filesTarget(projectKey),
      authorityOf: (projectKey) => authorityKeyOfProject(projectKeyOfRoot(projectKey)),
      transfers: (projectKey) => this.carriesTransfers(authorityKeyOfProject(projectKeyOfRoot(projectKey))),
      local: workspaces.local.files,
      platform: process.platform,
      askChecked: this.askChecked,
      notify,
      showDetails: async (message, lines) => {
        // the dialog's detail holds as many whole lines as fit, then how many more there are
        const shown: string[] = [];
        let size = 0;
        for (const line of lines) {
          if (size + line.length + 1 > MESSAGE_DETAIL_BUDGET) break;
          shown.push(line);
          size += line.length + 1;
        }
        const more = lines.length - shown.length;
        await this.ask({ severity: 'info', message, detail: [...shown, ...(more > 0 ? [t('and {0} more', more)] : [])].join('\n'), actions: [t('OK')], defaultAction: 0 });
      },
      renameInProject: (projectKey, from, renameOnDisk) => editorPane.fileRenamed(projectKey, from, renameOnDisk),
      progress: (progress) => this.shell?.filesTransferProgress(progress),
      changed: (change) => this.shell?.filesChanged(change),
      revealDownload: (absolutePath) => platform.shell.revealChosenPath(absolutePath),
      t,
      log: report,
    });
    const settingKey = { confirmDragAndDrop: FILES_CONFIRM_DRAG_AND_DROP_SETTING, confirmPasteNative: FILES_CONFIRM_PASTE_NATIVE_SETTING } as const;
    this.fileTransfers = transfers;
    this.transferGestures = new TransferGestures({
      start: (request) => transfers.start(request),
      connected: (projectKey) => transfers.connected(projectKey),
      transfers: (projectKey) => this.carriesTransfers(authorityKeyOfProject(projectKeyOfRoot(projectKey))),
      projects,
      target: (projectKey) => this.filesTarget(projectKey),
      localPathOf: (projectKey, relativeDir) => {
        const project = projects().find((candidate) => candidate.key === projectKey);
        if (!project) return undefined;
        const target = this.filesTarget(projectKey);
        const segments = relativeDir === '' ? [] : relativeDir.split('/');
        if (target.host === undefined) return path.join(project.fsPath, ...segments);
        return target.wslDistro === undefined ? undefined : linuxToWslUnc(target.wslDistro, path.posix.join(project.fsPath, ...segments));
      },
      kindOf: async (file) => {
        const project = projects().find((candidate) => candidate.key === file.projectKey);
        if (!project) return undefined;
        const files = workspaces.forProject(file.projectKey).files;
        if (file.relativePath === '') return 'dir';
        const entry = await files.entry(project, file.relativePath);
        if (!entry.ok) return undefined;
        if (entry.folder) return 'dir';
        // an entry's answer does not tell a link from a file; the walk's first entry, the item itself, does
        for await (const page of files.walk(project, file.relativePath)) return page[0]?.kind;
        return undefined;
      },
      clipboard: this.filesClipboard,
      askChecked: this.askChecked,
      notify: (severity, message) => void notify(severity, message),
      setting: (key) => platform.settings.get<boolean>(settingKey[key], true) !== false,
      stopAsking: (key) => platform.settings.update(settingKey[key], false, 'user'),
      pickToCopyIn: async () => {
        const window = this.window;
        // macOS lets one picker take files and folders together; elsewhere folders come by drag or paste
        const options: Electron.OpenDialogOptions = { title: t('Copy Files Here'), buttonLabel: t('Copy'), properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] };
        const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
        return result.canceled ? undefined : result.filePaths;
      },
      pickDownloadFolder: (defaultPath) => platform.nativeDialogs.pickFolder({ title: t('Download'), ...(defaultPath !== undefined ? { defaultPath } : {}), buttonLabel: t('Download Here') }),
      pickDownloadFile: async (defaultPath) => {
        const window = this.window;
        const options = { defaultPath, title: t('Download') };
        const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
        return result.canceled ? undefined : result.filePath;
      },
      lastDownloadFolder: () => platform.state.global.get<string>(LAST_DOWNLOAD_FOLDER_KEY),
      rememberDownloadFolder: (folder) => platform.state.global.update(LAST_DOWNLOAD_FOLDER_KEY, folder),
      platform: process.platform,
      t,
      log: report,
    });
  }

  private requireQuickOpenIndex(): QuickOpenIndex {
    if (!this.quickOpenIndex) throw new Error('Quick Open used before startup finished');
    return this.quickOpenIndex;
  }

  private requireScm(): ScmHost {
    if (!this.scm) throw new Error('Source control used before startup finished');
    return this.scm;
  }

  private requireSearch(): SearchHost {
    if (!this.search) throw new Error('Search used before startup finished');
    return this.search;
  }

  private requirePalette(): CommandPalette {
    if (!this.palette) throw new Error('The command palette used before startup finished');
    return this.palette;
  }

  // The true entries of damocles.desktop.search.exclude.
  private searchExcludePatterns(): string[] {
    const value = this.requirePlatform().settings.get<unknown>(SEARCH_EXCLUDE_SETTING);
    return excludeSettingGlobs(isDesktopSettingValue(SEARCH_EXCLUDE_SETTING, value) ? (value as Record<string, unknown>) : DEFAULT_SEARCH_EXCLUDE);
  }

  // Search's folder: the selected project's shown folder (D31), resolved against main's own roots.
  private searchFolder(): SearchFolder | undefined {
    const key = this.selectedProjectKey ?? this.client()?.defaultTarget()?.key;
    const root = key === undefined ? undefined : this.roots.resolve(this.shownFolders.rootKeyOf(key));
    return root ? { projectKey: root.key, fsPath: root.fsPath } : undefined;
  }

  // A chat feature in the selected chat (AD11), once that chat's view is ready.
  private runChatCommand(command: ChatCommand): void {
    const panel = this.views?.selected();
    if (!panel) return;
    const deps = this.entryActionDeps;
    void deps.whenReady(panel).then((ready) => {
      if (ready && this.views?.selected() === panel) deps.post(panel, { type: 'runChatCommand', command });
    }, this.report('Run Chat Command'));
  }

  // The project list as Files, Quick Open and the editor confine to it: each key is folderKey(fsPath), as the shell names it.
  private desktopProjects(): readonly Project[] {
    const client = this.client();
    return this.projects.folders().map((folder) => {
      const key = folderKey(folder.fsPath);
      return { key, fsPath: folder.fsPath, name: client?.resolve(key)?.label ?? folder.name };
    });
  }

  // The remote projects this run shows: the loopback authority's while LOOPBACK holds, and each saved host's.
  private remoteProjects(): RemoteProject[] {
    const store = this.hostStore;
    if (!store) return [];
    return store.projects().flatMap(({ authorityKey, project }): RemoteProject[] => {
      const authority = authorityKey === 'loopback' ? (LOOPBACK ? { kind: 'loopback' as const } : undefined) : this.hostAuthority(authorityKey);
      if (!authority) return [];
      return [{
        key: projectKeyOf(authority, project.folderKey),
        fsPath: project.path,
        name: pathFor(project).basename(project.path) || project.path,
        authorityKey,
        folderKey: project.folderKey,
        os: project.os,
      }];
    });
  }

  private remoteProject(key: string): RemoteProject | undefined {
    return this.remoteProjects().find((project) => project.key === key);
  }

  // A project of the sidebar's list, local or remote.
  private projectListed(key: string): boolean {
    if (authorityKeyOfProject(key) !== 'local') return this.remoteProject(key) !== undefined;
    return this.listedFolder(key) !== undefined;
  }

  private listedFolder(key: string): { fsPath: string; name: string } | undefined {
    return this.projects.folders().find((folder) => folderKey(folder.fsPath) === key);
  }

  // The name the sidebar shows (shellState) for a listed project; undefined once it left the list.
  private listedProjectName(key: string): string | undefined {
    if (authorityKeyOfProject(key) !== 'local') return this.remoteProject(key)?.name;
    const folder = this.listedFolder(key);
    return folder && (this.client()?.resolve(key)?.label ?? folder.name);
  }

  // A removed project's last chat goes with it, whichever path removed it.
  private forgetUnlistedProjects(): void {
    // relocateStores re-keys a remote move's entry before replaceProject lists its key; a host-store write in between keeps it
    this.lastChats.forgetProjectsExcept((key) => projectStays(key, (listed) => this.projectListed(listed), this.movedProjects));
  }

  // Files, the editor, Search, Quick Open, the formatter and terminals: every shown project, in the sidebar order.
  private workspaceProjects(): readonly Project[] {
    const byKey = new Map([...this.desktopProjects(), ...this.remoteProjects()].map((project) => [project.key, project]));
    return (this.hostStore?.order([...byKey.keys()]) ?? [...byKey.keys()]).map((key) => byKey.get(key)!);
  }

  // The daemons this app reaches: the loopback one, started over stdio through the launcher with a home in userData, and each
  // saved SSH host's through its ssh bridge.
  private startAuthorities(platform: DesktopPlatform): Authorities {
    const settings = platform.settings;
    return new Authorities({
      transport: async (authorityKey) => {
        if (this.heldTransports.has(authorityKey)) throw new Error('the e2e hooks hold the transport down');
        const hostId = this.savedHostIdOf(authorityKey);
        if (hostId !== undefined) return this.requireRemoteConnections().transport(hostId);
        if (authorityKey !== 'loopback') throw new Error(`No transport reaches ${authorityKey}`);
        const serverPackage = process.env['DAMOCLES_LOOPBACK_PACKAGE'];
        return startLoopbackTransport({
          execPath: process.execPath,
          daemonScript: path.join(platform.paths.unpackedRoot, 'dist', 'daemon.js'),
          home: path.join(this.userDataDir, 'loopback-home'),
          // beside the archive, so every launch that runs it (each e2e test has its own userData) unpacks it once
          ...(serverPackage ? { serverPackage: { archive: serverPackage, unpackRoot: path.join(path.dirname(serverPackage), 'unpacked') } } : {}),
          env: process.env,
          log: (line) => log(line),
        });
      },
      appVersion: appVersionOf(REMOTE_E2E.appVersion ?? platform.appInfo.version),
      clientId: this.clientId(),
      deviceName: REMOTE_E2E.deviceName ?? os.hostname(),
      ...(REMOTE_E2E.protocolVersion !== undefined ? { protocolVersion: REMOTE_E2E.protocolVersion } : {}),
      otherProtocol: (authorityKey, daemon) => this.followOtherProtocol(authorityKey, daemon),
      terminalIdleDays: () => {
        const value = settings.get<unknown>(REMOTE_TERMINAL_IDLE_DAYS_SETTING);
        return (isDesktopSettingValue(REMOTE_TERMINAL_IDLE_DAYS_SETTING, value) ? value : DESKTOP_CONFIGURATION[REMOTE_TERMINAL_IDLE_DAYS_SETTING]!.default) as number;
      },
      projectOfCwd: (authorityKey, cwd) => projectOfCwd(this.remoteFileRoots(authorityKey), cwd),
      changed: (authorityKey) => this.authorityChanged(authorityKey),
      adopt: (authorityKey, connection) => this.adoptDaemonVersion(authorityKey, connection),
      attached: (authorityKey, connection) => {
        // the damocles command in this authority's terminals, relayed by its daemon
        connection.workspace.serve('cli.request', (relay) => this.requireCliRequests().fromSocket(authorityKey, relay));
        const hostId = this.savedHostIdOf(authorityKey);
        if (hostId !== undefined) this.hostConnected(hostId, connection);
        // the loopback daemon has no host record to touch, mirror or update, and its ports work as any host's
        else if (authorityKey === 'loopback') this.ports?.connected(LOOPBACK_HOST, connection);
      },
      notConnected: (authorityKey) => this.notConnected(authorityKey),
      searchUnsupported: () => this.requireLocalization().t('Update the Damocles server on this host to search it.'),
      log: (line) => log(line),
    });
  }

  // A shutdown this client asked for is no outage: once the daemon ended the connection the authority is disconnected, as
  // Disconnect Host leaves it, so nothing reconnects (and so starts a daemon again) until the user connects.
  private async shutDownDaemon(authorityKey: string): Promise<void> {
    await shutDownNow(this.requireConnection(authorityKey), (line) => log(line));
    this.disconnectAuthority(authorityKey);
  }

  // Disconnect Host and what leaves an authority as it does: the reconnect loop stops, an attempt in flight ends and the
  // connection closes, so nothing connects until the user does. Settles once the attempt it ended settled.
  private disconnectAuthority(authorityKey: string): Promise<void> {
    this.reconnector?.disconnected(authorityKey);
    // nothing switches on a host not connected; the next connect finds the switch again from the stored pendingSince
    this.settleSwitch(authorityKey);
    const hostId = this.savedHostIdOf(authorityKey);
    const attemptEnded = hostId === undefined ? Promise.resolve() : (this.remoteConnections?.cancelHost(hostId) ?? Promise.resolve());
    this.authorities?.disconnect(authorityKey);
    return attemptEnded;
  }

  private cutTransport(authorityKey: string, hold: boolean): void {
    if (hold) this.heldTransports.add(authorityKey);
    this.requireAuthorities().cutTransport(authorityKey);
  }

  private notConnected(authorityKey: string): NotConnectedError {
    return new NotConnectedError(this.requireLocalization().t('{0} is not connected.', this.hostName(authorityKey)));
  }

  // An authority's workspace while it is connected; an action on its projects fails with this otherwise.
  private remoteWorkspace(authorityKey: string): ProjectWorkspace {
    const workspace = this.authorities?.connectedWorkspace(authorityKey);
    if (!workspace) throw this.notConnected(authorityKey);
    return workspace;
  }

  // The OS whose path rules an authority's paths follow: this computer's, or the target's as its connection, its projects or its
  // saved host record name it.
  private authorityOs(authority: string): NodeJS.Platform {
    const os = this.knownAuthorityOs(authority);
    if (os === undefined) throw this.notConnected(authority);
    return os;
  }

  private knownAuthorityOs(authority: string): NodeJS.Platform | undefined {
    if (authority === 'local') return process.platform;
    return authorityOsOf(this.authorities?.connection(authority)?.facts.os, this.remoteProjects().find((project) => project.authorityKey === authority)?.os, this.savedHostRecord(authority));
  }

  private projectOs(projectKey: string): NodeJS.Platform {
    return this.authorityOs(authorityKeyOfProject(projectKey));
  }

  // The authority's core once the window can show its chats: attached on each connection, made on the first.
  private connectRemoteCore(authorityKey: string): void {
    const connection = this.authorities?.connection(authorityKey);
    if (!connection || !this.views || this.lifecycle.phase !== 'running') return;
    this.remoteCoreOf(authorityKey).connected(connection);
    // the host card and the connect timeline name the other devices attached to the daemon
    const hostId = this.savedHostIdOf(authorityKey);
    if (hostId !== undefined && !this.devicesWatched.has(connection)) {
      this.devicesWatched.add(connection);
      connection.onDevices(() => this.remoteHosts?.hostChanged(hostId));
    }
  }

  private remoteCoreOf(authority: string): RemoteCore {
    const known = this.remoteCores.get(authority);
    if (known) return known;
    const remote = new RemoteCore({
      authority,
      hostId: this.hostIdOf(authority),
      connection: () => this.authorities?.connection(authority),
      services: (features) => this.remoteServicesOf(authority, features),
      lastEpoch: this.remoteState?.coreEpoch(authority) ?? null,
      openTabs: (core, rejoin, kept) => this.openRemoteChats(core, rejoin, kept).finally(() => {
        // an install of this host that expired while it was away ends its card now
        void this.relayedInstalls.connected(authority);
        this.reselectRemote.delete(authority);
        this.overlaySettings?.coreReady(authority);
      }),
      chatViews: () => this.remoteChatViews(authority).flatMap((view) => (view.panelToken !== undefined ? [{ viewId: view.panelId, panelToken: view.panelToken }] : [])),
      retainTabStates: (retain) => {
        // a chat selected when its core went is selected again when it reopens
        const selected = this.views?.selected();
        if (retain && selected?.authority === authority && selected.panelToken !== undefined) this.reselectRemote.set(authority, selected.panelToken);
        this.views?.retainAuthorityOnClose(authority, retain);
      },
      subscribe: (client) => this.subscribeRemote(authority, client),
      relays: this.requireUserRelays(),
      sharedLoopback: authority === 'loopback' || this.remoteHosts?.sharesClientLoopback(authority) === true,
      changed: () => {
        this.overlaySettings?.authorityChanged(authority);
        this.shellStateChanged();
        this.refreshMenuState();
      },
      keptChats: () => this.requireRemoteState().chats(authority).length,
      reattached: (restarted) => {
        this.reconnector?.attached({ authorityKey: authority, how: 'attached', ...(restarted ? { restarted } : {}) });
        this.remoteRelocationsFrom(authority).catch(this.report('Looking for moved projects'));
      },
      coreEnded: () => this.offlineQueue?.connectionEnded(authority),
      drainTimeoutMs: CLOSE_TIMEOUT_MS,
      log: (line) => log(line),
    });
    this.remoteCores.set(authority, remote);
    return remote;
  }

  private remoteChatViews(authority: string): DesktopPanel[] {
    return (this.views?.chats() ?? []).filter((chat) => chat.authority === authority);
  }

  // What main listens to on a remote core's client; its chats' entries go with the attach.
  private subscribeRemote(authority: string, client: CoreClient): Disposable[] {
    const key = (corePanelId: string): string => chatKey(authority, corePanelId);
    return [
      client.onHeldMemoryChanged(() => this.remoteHosts?.hostsChanged()),
      // a chat's screenshot grant ends with its session, on this signal or the page's saved state, whichever lands first
      client.onChatSessionChanged((viewId, sessionId) => {
        const page = this.views?.chats().find((chat) => chat.panelId === viewId && chat.authority === authority);
        if (page) this.relayedConsents.pageSession(page, sessionId);
      }),
      client.onFoldersChanged(() => {
        this.followSelectedChat();
        this.refreshScmRoots();
        this.shellStateChanged();
      }),
      client.onActivity((panelId, activity, sessionId) => {
        this.onChatActivity(key(panelId), activity);
        for (const listener of [...this.remoteStatusListeners]) listener(authority, panelId, closeStatusOf(activity));
        if (sessionId !== undefined) this.hostSessionActivity(authority, sessionId, activity);
      }),
      client.onChatChanges((panelId, totals, generation) => this.chatReviews.chatChanged(key(panelId), totals, generation)),
      client.onTurnSettled((panelId, outcome) => {
        this.remoteSessionsChanged(authority);
        const panel = this.panelOfCore(key(panelId));
        if (panel) this.chatsChanged(this.projectOf(panel));
        this.notificationCenter.turnSettled(key(panelId), outcome);
        this.scheduleRetention();
      }),
      client.onCatalogChanged((projectKey) => {
        for (const rowKey of [...this.catalogRows.keys()]) if (projectKey === undefined ? authorityKeyOfProject(rowKey) === authority : rowKey === projectKey) this.catalogRows.delete(rowKey);
        this.chatsChanged(projectKey);
        this.refreshSelectedCatalog();
      }),
      client.onTakeover((sessionId) => {
        if (this.views) this.selectChat(sessionId, authority).catch(this.report('Opening a conversation here'));
      }),
      client.onDesignChanged((designId, paths) => this.designPreviews?.designChanged(authority, designId, paths)),
      // the host's worktree chats: its registry, its chats' worktree states and its New Chat in This Worktree
      client.onWorktreeRecords((records) => this.remoteRecordsOf(authority).apply(records)),
      client.onWorktreeState((event) => this.onWorktreeState({ ...event, panelId: key(event.panelId) })),
      client.onNewChatInWorktree((projectPath, worktreeId) => {
        const project = this.remoteProjects().find((candidate) => candidate.authorityKey === authority && candidate.fsPath === projectPath);
        if (project) this.newChatInWorktree({ projectKey: project.key, worktreeId }).catch(this.newChatInWorktreeFailure());
      }),
      client.onNewChatInProject((projectPath) => {
        const project = this.remoteProjects().find((candidate) => candidate.authorityKey === authority && candidate.fsPath === projectPath);
        if (project) this.newChat(project.key).catch(this.shellFailure('New Chat', 'Damocles could not open a new conversation: {0}'));
      }),
      client.onUsageThreshold((crossing) => this.notificationCenter.usageThreshold(crossing)),
      client.onRelocationsChanged(() => this.relocationsChanged(authority, client)),
      this.requireScmClient().attach(client),
      {
        dispose: () => {
          this.forgetChatsOf(authority);
          for (const sessionKey of [...this.sessionActivity.keys()]) if (sessionKey.startsWith(`${authority}\n`)) this.sessionActivity.delete(sessionKey);
          this.overlaySettings?.coreEnded(client);
        },
      },
    ];
  }

  // The chats this window had open on the authority: rejoined under the epoch they were open in, else restored into new
  // panels that resume their sessions, with the permissions the ended core published for them.
  private async openRemoteChats(core: RemoteHostedCore, rejoin: boolean, kept: ReadonlyMap<string, ChatPermissions>): Promise<void> {
    // a chat of a project whose folder is gone stays closed, as a local one does, so its core never starts it there
    await this.remotePresences.check(this.checkedRemoteProjects(core.authority)).catch(this.report('Checking the remote project folders'));
    // before the chats reopen: a host part cut short re-keyed them to a destination the list does not name yet
    const moved = await this.remoteMovesFrom(core.authority, core.client).catch((err: unknown) => {
      this.report('Looking for moved projects')(err);
      return [];
    });
    for (const view of moved) if (view.state === 'coreDone') this.movedProjects.set(this.relocationKey(core.authority, view.to), this.relocationKey(core.authority, view.from));
    const projects = { known: (key: string) => this.projectListed(key) || this.movedFrom(key) !== undefined, absent: (key: string) => this.remotePresences.absent(key) };
    for (const [panelToken, skipped] of [...this.skippedRemoteChats]) if (skipped.authority === core.authority) this.skippedRemoteChats.delete(panelToken);
    const shown = this.remoteChatViews(core.authority).flatMap((view) => this.sessionIdOf(view) ?? []);
    for (const record of oncePerConversation(this.requireRemoteState().chats(core.authority), shown, this.reselectRemote.get(core.authority))) {
      if (this.remoteChatViews(core.authority).some((view) => view.panelToken === record.panelToken)) continue;
      const fate = keptChatFate(record.projectKey, projects);
      if (fate === 'dropped') continue;
      if (fate === 'closed') {
        this.skippedRemoteChats.set(record.panelToken, { ...record, projectKey: record.projectKey! });
        continue;
      }
      await this.openRemoteChat(core, record, rejoin, kept.get(record.panelToken)).catch(this.report('Reopening a remote chat'));
    }
    this.reselectRemote.delete(core.authority);
    this.reopenedRemoteChats.add(core.authority);
    this.saveRemoteChats(core.authority);
    this.designPreviews?.connectionChanged(core.authority, true);
    this.scheduleRetention();
    await this.remoteSelection.coreOpened(core).catch(this.report('Opening the selected project\'s chat'));
  }

  // One kept chat into a new view: rejoined under the epoch it was open in, under a new one joined to the panel another device
  // restored its conversation into, else restored into a new panel, resuming its session (reopenKeptChat).
  private openRemoteChat(core: RemoteHostedCore, record: RemoteChatRecord, rejoin: boolean, permissions: ChatPermissions | undefined): Promise<void> {
    const host = this.requireViews().create({ options: CHAT_PANEL, restore: { panelId: randomUUID(), state: { ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}), panelToken: record.panelToken } }, authority: core.authority });
    this.trackChat(host, keptRemoteChatProjectKey(record, { listed: (key) => this.projectListed(key), movedFrom: (key) => this.movedFrom(key), defaultKey: this.defaultProjectKey(core) }));
    this.lastViewed.set(host, ++this.viewCount);
    if (this.reselectRemote.get(core.authority) === record.panelToken && !this.views?.selected()) this.showChat(host, { focus: 'whenReady' });
    const restore = reopenKeptChat(record, rejoin, {
      join: (viewKey, sessionId) => core.rejoin(host, viewKey, sessionId),
      restoreJoining: async () => {
        if (!host.isDisposed) await core.client.restoreRelayed(host.panelId, permissions);
      },
      restore: () => core.client.restoreChat(host, undefined, permissions),
    });
    this.chatRestores.set(host, restore);
    return restore;
  }

  // The skipped chats of a remote project whose folder is back, or that moved (saved under its new key by then), open again.
  private reopenSkippedRemoteChats(projectKey: string): void {
    const authority = authorityKeyOfProject(projectKey);
    const core = this.remoteCores.get(authority)?.host.current();
    const reopening = [...this.skippedRemoteChats.values()].filter((skipped) => skipped.projectKey === projectKey);
    if (!core || reopening.length === 0) return;
    let previous: Promise<void> = Promise.resolve();
    for (const record of reopening) {
      this.skippedRemoteChats.delete(record.panelToken);
      previous = previous.then(() => this.openRemoteChat(core, record, false, undefined)).catch(this.report('Reopening a remote chat'));
    }
    void previous.then(() => {
      this.saveRemoteChats(authority);
      this.scheduleRetention();
    });
  }

  // remote-state.json's chats for the authority: each open chat with a conversation or held messages, and each skipped one,
  // under the epoch they are open in. A quit, disconnect or engine restart closes them with their records kept.
  private saveRemoteChats(authority: string): void {
    const views = this.views;
    const state = this.remoteState;
    const remote = this.remoteCores.get(authority);
    if (!views || !state || !remote || !this.reopenedRemoteChats.has(authority) || views.retainingAuthority(authority)) return;
    const open: RemoteChatRecord[] = this.remoteChatViews(authority).flatMap((view) => {
      const sessionId = this.sessionIdOf(view);
      const panelToken = view.panelToken;
      if (panelToken === undefined) return [];
      const projectKey = this.projectOf(view);
      const project = projectKey !== undefined ? { projectKey } : {};
      if (sessionId !== undefined) return [{ authority, sessionId, panelToken, ...project }];
      // a new chat that has no conversation yet reopens new, with the messages it holds
      return (this.offlineQueue?.queued(panelToken).length ?? 0) > 0 ? [{ authority, panelToken, ...project }] : [];
    });
    const records = [...open, ...[...this.skippedRemoteChats.values()].filter((skipped) => skipped.authority === authority)];
    const text = JSON.stringify([records, remote.epoch()]);
    if (this.savedRemoteChats.get(authority) === text) return;
    this.savedRemoteChats.set(authority, text);
    state.setChats(authority, records, remote.epoch()).catch(this.report('Saving the remote chats'));
  }

  private requireRemoteState(): RemoteState {
    if (!this.remoteState) throw new Error('Remote state used before startup finished');
    return this.remoteState;
  }

  // This computer's user scope for remote cores: the local core's credentials, and the client mirrors each attach follows.
  private startUserRelays(platform: DesktopPlatform, resourceRoot: string): UserRelays {
    const contributed = readContributedConfiguration(resourceRoot);
    const relays = new UserRelays({
      resolveCredential: (provider) => this.core.run('Credentials for a remote chat', (core) => core.client.resolveCredential(provider)),
      clientAuth: () => this.core.run('Sign-ins for remote chats', (core) => core.client.clientAuth()),
      voice: desktopHostCapabilities(process.platform).voice,
      homedir: homeDirectory(),
      userSettingKeys: () => relayedUserSettingKeys(contributed),
      userValue: (key) => platform.settings.inspect(key).userValue,
      local: {
        memorySearch: (query, k, tiers, injection, filters) => this.core.run('Global memory for a remote chat', (core) => core.client.memorySearch(query, k, tiers, injection, filters)),
        memoryProfile: () => this.core.run('Global memory for a remote chat', (core) => core.client.memoryProfile()),
        memoryResolve: (ids) => this.core.run('Global memory for a remote chat', (core) => core.client.memoryResolve(ids)),
        memoryApply: (writes) => this.core.run('Global memory for a remote chat', (core) => core.client.memoryApply(writes)),
        memoryList: (request) => this.core.run('Global memory for a remote chat', (core) => core.client.memoryList(request)),
        mcpServers: () => this.core.run('Personal MCP servers for remote chats', (core) => core.client.mcpServers()),
        mcpCall: (server, tool, args, signal) => this.core.run('A personal MCP server for a remote chat', (core) => core.client.mcpCall(server, tool, args, signal)),
        mcpResources: (server, kind, cursor, signal) => this.core.run('A personal MCP server for a remote chat', (core) => core.client.mcpResources(server, kind, cursor, signal)),
        mcpReadResource: (server, uri, signal) => this.core.run('A personal MCP server for a remote chat', (core) => core.client.mcpReadResource(server, uri, signal)),
      },
      forges: async () => (await this.core.run('Reading the Git hosting servers for remote hosts', (core) => core.client.forgeServersRead())).servers,
      engineHalted: () => this.core.halted(),
      notifications: platform.notifications,
      hostPolicy: (authorityKey) => {
        const hostId = this.savedHostIdOf(authorityKey);
        const record = hostId === undefined ? undefined : this.hostStore?.host(hostId);
        if (!record) return { allowBypass: false };
        const { allowBypass, defaultPermissionMode } = record.settings;
        return { allowBypass: allowBypass === true, ...(defaultPermissionMode !== undefined ? { defaultPermissionMode } : {}), agentForwarding: forwardsAgent(record) };
      },
      savedHost: (authorityKey) => {
        const hostId = this.savedHostIdOf(authorityKey);
        return hostId !== undefined && this.hostStore?.host(hostId) !== undefined;
      },
      log: (line) => log(line),
    });
    const refresh = (): void => {
      relays.userChanged().catch(this.report('Reading the user settings for remote chats'));
    };
    // based at the scope root, so the watcher factory judges a link at the folder by the network rule (D10)
    const watchers = ['.damocles', '.claude'].map((name) => {
      const dir = path.join(homeDirectory(), name);
      const base = userConfigBase(path.join(dir, 'settings.json'), homeDirectory());
      const folder = path.relative(base, dir).split(path.sep).join('/');
      return platform.fileWatchers.watch(base, `${folder === '' ? '' : `${folder}/`}{settings.json,settings.local.json}`);
    });
    for (const watcher of watchers) {
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
    }
    this.disposables.push(relays, ...watchers, platform.settings.onDidChange('damocles', refresh));
    refresh();
    return relays;
  }

  private requireUserRelays(): UserRelays {
    if (!this.userRelays) throw new Error('Remote user relays used before startup finished');
    return this.userRelays;
  }

  // The roots a remote core's path may name on its host: its live chat worktrees (keyed by root key) before its projects, each
  // project also at the realpath its core resolved on the target.
  private remoteFileRoots(authority: string): RemoteFileRoot[] {
    const projects = this.remoteProjects().filter((project) => project.authorityKey === authority);
    const worktrees = this.roots.all().flatMap((root): RemoteProject[] => {
      const project = root.worktree ? projects.find((candidate) => candidate.key === root.root.projectKey) : undefined;
      return project ? [{ ...project, key: root.key, fsPath: root.fsPath }] : [];
    });
    return [...worktrees, ...projects.map((project) => {
      const realPath = this.scmClient?.projectRealPath(project.key);
      return realPath === undefined ? project : { ...project, realPath };
    })];
  }

  // A remote diff's target path, on that host only: a file of the host's roots by remoteFileRef, any other absolute host path
  // as it is. Its errors reach the core, so they never name the host.
  private remoteDiffTarget(authority: string, target: string): RemoteDiffTarget {
    const ref = remoteFileRef(this.remoteFileRoots(authority), target);
    if (ref) return ref;
    if (!isAbsoluteOn({ os: this.authorityOs(authority) }, target)) throw new Error(`${target} is not an absolute path`);
    return { authority, path: target };
  }

  // A remote core's diff: every target path resolves through remoteDiffTarget, and an approval diff goes to the asking chat's
  // own view, never matched against this computer's editors by path.
  private async showRemoteDiff(authority: string, request: DiffRequest): Promise<HostDiffView> {
    const file = this.remoteDiffTarget(authority, request.filePath);
    const side = (diffSide: DiffSide): { readonly file: RemoteDiffTarget } | { readonly name: string; readonly content: string } => ('path' in diffSide ? { file: this.remoteDiffTarget(authority, diffSide.path) } : diffSide);
    const left = side(request.left);
    const right = side(request.right);
    const pane = this.requireEditorPane();
    if (request.approvalId === undefined) {
      const view = await pane.showRemoteDiff((fileName) => this.requireLocalization().render(request.title(fileName)), file, left, right, { focus: request.preserveFocus !== true });
      return { close: () => Promise.resolve(view.close()), closed: view.closed };
    }
    const client = this.clientFor(authority);
    const panelId = request.panelId;
    if (!client || panelId === undefined) throw new Error('An approval diff names no loaded chat');
    const name = 'projectKey' in file ? path.posix.basename(file.relativePath) : this.hostPathFlavor(authority).basename(file.path);
    // an approval diff's sides are core-originated texts; a file side is read only inside the host's roots
    const document = async (diffSide: typeof left): Promise<EditorDocument> => {
      if (!('file' in diffSide)) return memoryDocument(diffSide.name, diffSide.content);
      if (!('projectKey' in diffSide.file)) throw new Error(`${diffSide.file.path} is not in an open project`);
      return memoryDocument(path.posix.basename(diffSide.file.relativePath), await pane.projectFileText(diffSide.file));
    };
    const [original, modified] = await Promise.all([document(left), document(right)]);
    const viewId = randomUUID();
    await client.post(panelId, { type: 'editorShowDiff', viewId, title: request.title(name), purpose: 'proposal', approvalId: request.approvalId, original, modified });
    let settle!: () => void;
    const closed = new Promise<void>((resolve) => (settle = resolve));
    let closing = false;
    return {
      close: async () => {
        if (closing) return;
        closing = true;
        await client.post(panelId, { type: 'editorCloseView', viewId }).catch(this.report('Closing a remote diff'));
        settle();
      },
      closed,
    };
  }

  private hostPathFlavor(authority: string): path.PlatformPath {
    return pathFor({ os: this.authorityOs(authority) });
  }

  // A daemon's core offers only its host's own settings file (the host tab's), which its workspace reads and saves.
  private async showRemoteSettingsFile(authority: string, scope: SettingsFileScope, key: string | undefined): Promise<void> {
    const { t } = this.requireLocalization();
    if (scope !== 'user') throw new Error(t('This settings file does not apply now.'));
    await this.requireEditorPane().openHostSettingsFile(authority, t('{0}: {1}', this.hostName(authority), 'settings.json'), key);
  }

  // A chat page's message main takes: a file of another authority is refused, a remote chat's FOREIGN_VIEW_MESSAGES go to
  // this computer's core, and a remote chat's own file goes to its core as a mention.
  private divertViewMessage(view: RelayView, message: unknown): boolean {
    const panel = this.views?.panel(view.panelId);
    if (!panel || panel !== view || panel.kind !== 'chat') return false;
    const from = crossedByViewMessage(panel.authority, message);
    if (from !== undefined) {
      void this.notifications.warn(this.crossAuthorityRefusal(panel.authority, from));
      return true;
    }
    // ahead of the offline queue, so a user-setting write saves on this computer while the host is away
    if (this.foreignViews.fromView(panel.panelId, message)) return true;
    // a remote chat's install card stages on this computer, so its Allow flashing goes to this computer's core, never the chat's
    if (panel.authority !== 'local' && (message as { type?: unknown }).type === 'allowThemeInstallFlash') {
      allowRelayedInstallFlash(this.themeRelayDeps(panel.authority), message, new AbortController().signal).catch(this.report('Allowing a theme wallpaper to flash'));
      return true;
    }
    // this computer holds a remote chat's screenshot grant ("Desktop themes"), so the page's strip Revoke ends here, also while the host is away
    if (panel.authority !== 'local' && (message as { type?: unknown }).type === 'revokeThemeScreenshotGrant') {
      this.relayedConsents.revokePage(panel);
      return true;
    }
    // a reloaded page hears its grant again; it goes on to core as well
    if (panel.authority !== 'local' && (message as { type?: unknown }).type === 'ready' && this.relayedConsents.pageGranted(panel.panelId)) {
      void panel.postMessage({ type: 'themeScreenshotGrant', granted: true });
    }
    // a theme card's press counts only as main saw it here, and only while it goes on to the chat's core: none is held while the host is away
    if (panel.authority !== 'local') this.relayedConsents.pressed(panel, message, !panel.offline && this.authorities?.connection(panel.authority) !== undefined);
    if (this.holdWhileAway(panel, message)) return true;
    const dropped = ownRemoteDrop(panel.authority, message);
    if (dropped) {
      this.chatHost(panel.authority).run('Mention a dropped file', async (core) => {
        const corePanelId = this.corePanelIdOf(panel);
        if (corePanelId === undefined) throw new Error('The chat is not loaded');
        await core.client.mention(corePanelId, dropped);
      }).catch(this.report('Mentioning a dropped file'));
      return true;
    }
    // the chat header's open browser: a remote chat's pages belong to this computer's core, so main opens it
    if (panel.authority !== 'local' && (message as { type?: unknown }).type === 'openBrowser') {
      this.browserTabs?.newPage(panel).catch(this.report('Opening the browser'));
      return true;
    }
    return false;
  }

  // A remote core's services: main's own, with the refusals and the host store's trust for this authority.
  // features: the welcome of the connection serving that core, which Authorities.connection hides while it is suspect
  private remoteServicesOf(authority: string, features: readonly string[]): Omit<HostServicesDeps, 'endpoint'> {
    const deps = this.requireCoreDeps();
    const wsl = this.hostAuthority(authority);
    const credentialDaemon = { takesForgeAnswers: features.includes(CREDENTIAL_ORIGIN_FEATURE), verifiesErase: features.includes(VERIFIED_ERASE_FEATURE) };
    return remoteServices({
      authority,
      hostId: this.hostIdOf(authority),
      ...(wsl?.kind === 'wsl' ? { wslDistro: wsl.distro } : {}),
      hostName: () => this.hostName(authority),
      platform: deps.platform,
      runProcess: (spec) => runProcess(spec),
      projects: () => this.remoteProjects().filter((project) => project.authorityKey === authority),
      fileRoots: () => this.remoteFileRoots(authority),
      onProjectsChanged: (listener) => this.requireHostStore().onDidChange(listener),
      activeContext: () => this.requireEditorPane().activeContext(),
      onDidChangeActiveContext: (listener) => this.requireEditorPane().onDidChangeActiveContext(listener),
      trust: this.remoteHostTrust(authority),
      openNamedPath: async (targetPath, line, focus) => {
        await this.requireEditorPane().openNamedPath(authority, targetPath, { ...(line !== undefined ? { line } : {}), focus });
      },
      showLog: (name, preserveFocus) => {
        this.showRemoteLog(authority, logFileName(name), preserveFocus).catch(this.report('Show Log'));
      },
      isDirty: (targetPath) => this.requireEditorPane().isFileDirty(authority, targetPath),
      showDiff: (request) => this.showRemoteDiff(authority, request),
      showMarkdown: async (targetPath, content) => {
        const name = this.hostPathFlavor(authority).basename(targetPath);
        this.requireEditorPane().openMarkdownText(this.requireLocalization().t('{0}: {1}', this.hostName(authority), name), content, true, authority);
      },
      showChatReview: (corePanelId, scope) => this.showChatReview(chatKey(authority, corePanelId), scope),
      openSettingsFile: (scope, key) => this.showRemoteSettingsFile(authority, scope, key),
      pick: (mode, options) => this.requireRemoteHosts().pick(authority, mode, options),
      openLink: (url) => this.requireOpenUrl().coreOpenExternal(authority, url),
      ui: { ask: deps.ui.ask, askpass: deps.ui.askpass, worktrees: this.worktreesOf(authority).ui() },
      notices: this.hostNotices(authority),
      user: {
        credentials: (provider) => this.requireUserRelays().credentials(authority, provider, this.authorities?.connection(authority)?.features ?? []),
        speak: (viewId, text) => this.foreignViews.speak(authority, viewId, text),
        gitCredential: (request, signal) => this.gitCredentialClient().handle(this.hostIdOf(authority), request, credentialDaemon, signal),
        browserTool: (request, signal) => relayBrowserTool({
          authority,
          attachView: (viewId) => this.foreignViews.attachView(viewId, authority),
          tunnels: () => this.requirePorts().forwarding.forwardingFor(this.hostIdOf(authority)),
          policy: () => this.clientNetworkPolicy(authority),
          served: {
            grant: (served) => this.servedRoots.grant({ authority, ...served }),
            mappings: (viewId) => this.servedRoots.mappings(authority, viewId),
            viewOrigins: (viewId) => this.servedRoots.viewOrigins(authority, viewId),
          },
          run: (params, abort) => this.core.run('Browser tool', (core) => core.client.browserTool(params, abort)),
        }, request, signal),
        browserRelease: (agentScope) => this.core.run('Browser tool', (core) => core.client.releaseBrowser(authority, agentScope)),
        memorySearch: ({ query, k, tiers, injection, since, until, includeForgotten }) => this.requireUserRelays().memorySearch(authority, query, k, tiers, injection === true, { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(includeForgotten === true ? { includeForgotten } : {}) }),
        memoryProfile: () => this.requireUserRelays().memoryProfile(),
        memoryResolve: (ids) => this.requireUserRelays().memoryResolve(ids),
        memoryApply: ({ entries }) => this.requireUserRelays().memoryApply(authority, entries),
        memoryList: ({ kinds, tags, cursor }) => this.requireUserRelays().memoryList(authority, { kinds, ...(tags !== undefined ? { tags } : {}), ...(cursor !== undefined ? { cursor } : {}) }),
        mcpCall: ({ server, tool, args }, signal) => this.requireUserRelays().mcpCall(authority, server, tool, args, signal),
        mcpResources: ({ server, kind, cursor }, signal) => this.requireUserRelays().mcpResources(authority, server, kind, cursor, signal),
        mcpReadResource: ({ server, uri }, signal) => this.requireUserRelays().mcpReadResource(authority, server, uri, signal),
        forgeTool: ({ clientId: _clientId, ...call }, signal) => relayForgeTool(this.forgeRelayDeps(authority), call, signal),
        forgeDescribe: ({ clientId: _clientId, ...call }, signal) => relayForgeDescribe(this.forgeRelayDeps(authority), call, signal),
        theme: (method, params, signal) => relayTheme(this.themeRelayDeps(authority), method, params, signal),
      },
      base: {
        render: deps.render,
        divert: deps.divert,
        terminalToggle: deps.terminalToggle,
        createView: (panelId, create) => this.createCoreView(panelId, create, authority),
        git: deps.git,
        e2eHooks: deps.e2eHooks,
        paths: deps.paths,
        logs: deps.logs,
        language: deps.language,
        log: deps.log,
        showSession: (sessionId) => this.showSessionOf(authority, sessionId),
        openDesignPreview: (corePanelId, designId, relPath) => this.openDesignPreview(authority, corePanelId, designId, relPath),
        designRender: this.designRenderFor(authority),
      },
      t: (message, ...args) => this.requireLocalization().t(message, ...args),
    });
  }

  // A remote chat's GitHub and GitLab tools: this host's projects, this computer's switch, and its core with its accounts.
  private forgeRelayDeps(authority: string): ForgeRelayDeps {
    const platform = this.requireCoreDeps().platform;
    return {
      authority,
      projects: () => this.remoteProjects(),
      os: () => this.knownAuthorityOs(authority),
      enabled: () => {
        const value = platform.settings.get<unknown>(FORGE_AGENT_TOOLS_SETTING);
        return isDesktopSettingValue(FORGE_AGENT_TOOLS_SETTING, value) ? value === true : DESKTOP_CONFIGURATION[FORGE_AGENT_TOOLS_SETTING]!.default === true;
      },
      attachView: (viewId) => this.foreignViews.attachIfShown(viewId, authority),
      tool: (params, signal) => this.core.run('A GitHub or GitLab tool for a remote chat', (core) => core.client.forgeTool(params, signal)),
      describe: (params, signal) => this.core.run('A GitHub or GitLab tool for a remote chat', (core) => core.client.forgeDescribe(params, signal)),
      log: (line) => log(line),
    };
  }

  // A remote chat's theme tools: this computer's switch, its name, the host's projects here, and its core, the only writer.
  private themeRelayDeps(authority: string): ThemeRelayDeps {
    const shots = this.agentThemes.services();
    return {
      authority,
      enabled: () => this.themeToolsOn(),
      computer: () => os.hostname(),
      project: (folder) => {
        const project = hostProjectOf({ authority, projects: () => this.remoteProjects(), os: () => this.knownAuthorityOs(authority) }, folder);
        return project ? { key: project.key, name: project.name } : undefined;
      },
      validated: (theme) => this.agentThemes.validated(theme),
      core: {
        'themes.relay.read': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.read', params, signal)),
        'themes.relay.uploadStart': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.uploadStart', params, signal)),
        'themes.relay.uploadChunk': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.uploadChunk', params, signal)),
        'themes.relay.stage': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.stage', params, signal)),
        'themes.relay.commit': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.commit', params, signal)),
        'themes.relay.discard': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.discard', params, signal)),
        'themes.relay.preview': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.preview', params, signal)),
        'themes.relay.installPrepare': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.installPrepare', params, signal)),
        'themes.relay.installCommit': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.installCommit', params, signal)),
        'themes.relay.installCancel': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.installCancel', params, signal)),
        'themes.relay.allowFlash': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.allowFlash', params, signal)),
        'themes.relay.draftTheme': (params, signal) => this.core.run('A theme tool for a remote chat', (core) => core.client.themeRelay('themes.relay.draftTheme', params, signal)),
      },
      screenshots: {
        take: async (ask, signal) => this.agentThemes.take({ ...ask, origin: authority }, signal),
        read: async (shotId, signal) => (await shots['themes.screenshotRead']({ shotId }, signal)).png,
        drop: async (shotId) => {
          await shots['themes.screenshotDrop']({ shotId }, new AbortController().signal);
        },
      },
      shotGone: (shotId) => tellShotGone(this.relayedShots, authority, shotId),
      previews: this.relayedPreviews,
      installs: this.relayedInstalls,
      consents: this.relayedConsents,
      log: (line) => log(line),
    };
  }

  private themeToolsOn(): boolean {
    const value = this.requireCoreDeps().platform.settings.get<unknown>(THEMES_AGENT_TOOLS_SETTING);
    return isDesktopSettingValue(THEMES_AGENT_TOOLS_SETTING, value) ? value === true : DESKTOP_CONFIGURATION[THEMES_AGENT_TOOLS_SETTING]!.default === true;
  }

  // The tools were turned off here: a remote card's proposal leaves the window, and its core hears it stopped.
  private endRelayedPreviewWhileOff(): void {
    const strip = this.agentThemes.proposalStrip();
    if (!strip || this.themeToolsOn() || !this.relayedPreviews.shows(strip.promptId)) return;
    this.agentThemes.stopShowing().catch(this.report('Ending the Show in window of a remote chat'));
  }

  // Forget host: main's own record of the host's theme cards, presses, shots, previews and installs.
  private forgetRelayedThemes(authority: string): void {
    const drop = this.agentThemes.services()['themes.screenshotDrop'];
    for (const shotId of this.relayedConsents.forgetAuthority(authority)) void drop({ shotId }, new AbortController().signal);
    this.relayedPreviews.forgetAuthority(authority);
    this.relayedInstalls.forgetAuthority(authority);
  }

  // The authority's trust as its core reads it: the host store's grants for its projects, for the new folder of each move of its
  // core, from this run's relocate request on, so the move's repair step reads the trust Locate asked for, and for each folder
  // trustPending holds, so movedFrom and preflight read the root commits of a folder being added or located.
  private remoteHostTrust(authority: string): HostTrust {
    const ofAuthority = (key: string): boolean => authorityKeyOfProject(key) === authority;
    const moved = (fsPath: string): HostTrustFolder => ({ folderKey: folderKeyOn(this.authorityOs(authority), fsPath), fsPath });
    return remoteHostTrust({
      authorityKey: authority,
      store: this.requireHostStore(),
      folders: () => [
        ...this.remoteProjects().filter((project) => project.authorityKey === authority),
        ...(this.clientFor(authority)?.relocations() ?? []).map((view) => moved(view.to)),
        ...[...this.locatePrepared.values()].filter((prepared) => ofAuthority(prepared.key)).map((prepared) => moved(prepared.to)),
        ...[...this.locateTargets].filter(([key]) => ofAuthority(key)).map(([, to]) => moved(to)),
        ...this.trustPending.folders(authority),
      ],
      onDidChangeFolders: (listener) => this.relocationTargetsChanged.add((changed) => {
        if (changed === authority) listener();
      }),
      // only a project of this authority, named by its exact path on the target, is ever asked about
      requestTrust: async (folderPath) => {
        const project = this.remoteProjects().find((candidate) => candidate.authorityKey === authority && candidate.fsPath === folderPath);
        return project ? this.requireRemoteTrust().request(this.remoteTrustTarget(project)) : false;
      },
    });
  }

  // Each remote host's engine for the title bar: restarting while a Restart the user asked for is in flight, halted while the
  // daemon keeps it down, and starting for the daemon's own restart after a crash.
  private engines(): ShellEngine[] {
    return [...this.remoteCores].map(([authority, remote]): ShellEngine => ({ authority, name: this.hostName(authority), state: remote.engineState() }));
  }

  private requireAuthorities(): Authorities {
    if (!this.authorities) throw new Error('Remote hosts used before startup finished');
    return this.authorities;
  }

  // The id this install gives every daemon it attaches to, drawn once and kept in userData.
  private clientId(): string {
    const stored = this.state.global.get<string>(REMOTE_CLIENT_ID_KEY);
    if (stored !== undefined) return stored;
    const drawn = randomUUID();
    this.state.global.update(REMOTE_CLIENT_ID_KEY, drawn).catch(this.report('Saving the remote client id'));
    return drawn;
  }

  // An SSH host connects through its attempt, whose prompt waits behind the sign-in banner, since no user waits in the Connect
  // dialog; its failure shows on the host, not as a toast. userStarted: the user's gesture (opening a project) started it.
  private connectAuthority(authorityKey: string, userStarted: boolean): void {
    const hostId = this.savedHostIdOf(authorityKey);
    if (hostId !== undefined) {
      if (this.hostStore?.host(hostId)) this.requireRemoteConnections().connect(hostId, false, { user: userStarted });
      return;
    }
    this.authorities?.connect(authorityKey).catch(this.report(`Connecting to ${authorityKey}`));
  }

  private requireRemoteConnections(): RemoteConnections {
    if (!this.remoteConnections) throw new Error('Remote connections used before startup finished');
    return this.remoteConnections;
  }

  // Connect to Host..., a host's sign-in banner and every "open another folder on <host>": opens the Connect dialog, its
  // outcome reported here.
  private openConnect(hostId: string | undefined, options?: ConnectDialogOptions): void {
    this.requireRemoteHosts().openConnect(hostId, options).catch(this.shellFailure('Connect to Host', 'Damocles could not open the Connect dialog: {0}'));
  }

  // Remote: Open Folder on Host...: the host first, then its folder browser.
  private async openFolderOnHost(): Promise<void> {
    const hosts = this.requireRemoteHosts().shellHosts();
    const { t } = this.requireLocalization();
    const ask = createQuickPickAsker({
      overlay: () => this.overlay,
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      unavailable: () => void this.notifications.error(t('The list could not be shown, so nothing was changed. Try again.')),
      tooLarge: () => void this.notifications.error(t('The list has too many entries to show, so nothing was changed.')),
      log: (line) => log(line),
    });
    const picked = await ask(t('Select the host to open a folder on'), hosts.map((host) => ({ id: host.hostId, label: host.name })));
    if (picked) this.openConnect(picked.id);
  }

  // The banner's and the offline placeholder's Reconnect, and the failure's Retry: an attempt at once; one only a watched
  // attempt goes on with (a container to build) opens the Connect dialog, whose attempt the user watches.
  private reconnectHost(hostId: string): void {
    if (!this.hostStore?.host(hostId)) throw new Error(`No saved host ${hostId}`);
    if (this.requireRemoteConnections().needsWatchedAttempt(hostId)) {
      this.openConnect(hostId);
      return;
    }
    const authority = this.authorityOfHost(hostId);
    if (this.hasOpenViews(authority)) this.reconnector?.reconnectNow(authority, true);
    else this.requireRemoteConnections().connect(hostId, false, { force: true, user: true });
  }

  // Disconnect Host: the selected project's host connection ends; its daemon and terminals keep running there.
  private disconnectSelectedHost(): void {
    const key = this.selectedProjectKey;
    const project = key === undefined ? undefined : this.remoteProject(key);
    if (!project) return;
    this.disconnectAuthority(project.authorityKey);
  }

  // The reconnect loop and the latency measurer (docs/invariants.md "Remote daemon and wire"); a resume from sleep and the
  // network coming back wake the loop.
  private startReconnects(): void {
    const authorities = this.requireAuthorities();
    const hostOf = (authority: string): string | undefined => this.savedHostIdOf(authority);
    this.reconnector = new Reconnector({
      // a host whose security floor is above this app reads as the one whose newer daemon the flow follows: no loop, no failed phase
      handedOff: (authority) => {
        const pending = this.pendingSwitches.get(authority);
        return pending?.following() !== undefined || pending?.update()?.outdated === 'floor';
      },
      state: (authority) => authorities.state(authority),
      usable: (authority) => authorities.connection(authority) !== undefined,
      held: (authority) => authorities.heldConnection(authority),
      hostExists: (authority) => {
        const hostId = hostOf(authority);
        return hostId === undefined ? authority === 'loopback' : this.hostStore?.host(hostId) !== undefined;
      },
      hasOpenViews: (authority) => this.hasOpenViews(authority),
      attempt: (authority, signal, force, user) => this.reconnectAttempt(authority, signal, force, user),
      staging: (authority) => {
        const hostId = hostOf(authority);
        return hostId !== undefined && (this.remoteConnections?.staging(hostId) ?? false);
      },
      watched: (authority) => {
        const hostId = hostOf(authority);
        return hostId !== undefined && (this.remoteConnections?.isWatched(hostId) ?? false);
      },
      failureOf: (err) => failureOf(err),
      lastFailure: (authority) => {
        const hostId = hostOf(authority);
        return hostId === undefined ? undefined : this.remoteConnections?.failure(hostId);
      },
      signInNeeded: (authority) => {
        const hostId = hostOf(authority);
        return hostId !== undefined && (this.remoteConnections?.signInNeeded(hostId) ?? false);
      },
      endMaster: async (authority) => {
        const hostId = hostOf(authority);
        const host = hostId === undefined ? undefined : this.hostStore?.sshHost(hostId);
        const plan = hostId === undefined ? undefined : this.controlPlans.get(hostId);
        if (!host || !plan) return;
        await exitControlMaster(this.controlMasterDeps(), sshDestination(host.destination, (line) => log(line)), SSH_ENVIRONMENT.configFile, plan);
      },
      online: () => net.isOnline(),
      log: (line) => log(line),
    });
    this.disposables.push(this.reconnector.onEvent((event) => this.reconnectEvent(event)));
    this.latency = new LatencyMeter({
      ping: async (authority) => {
        await this.requireConnection(authority).control.request('ping', {});
      },
      changed: (authority) => {
        const hostId = hostOf(authority);
        if (hostId !== undefined) this.remoteHosts?.hostChanged(hostId);
        this.shellStateChanged();
      },
      log: (line) => log(line),
    });
    const resumed = (): void => {
      // their timers' clock stopped during sleep on macOS and Linux, as Chromium's base::WallClockTimer knows
      this.pendingSwitches.resumed();
      this.switchReminders.resumed();
      this.reconnector?.wake('the computer resumed from sleep');
    };
    powerMonitor.on('resume', resumed);
    this.disposables.push({
      dispose: () => {
        powerMonitor.removeListener('resume', resumed);
        this.reconnector?.dispose();
        this.latency?.dispose();
      },
    });
  }

  // One unwatched attempt of the loop: an SSH host's through its attempt, whose prompt waits behind the sign-in banner, the
  // loopback daemon's straight through Authorities.
  private reconnectAttempt(authority: string, signal: AbortSignal, force: boolean, user: boolean): LoopAttempt {
    const hostId = this.savedHostIdOf(authority);
    if (hostId === undefined) return { joined: false, outcome: this.requireAuthorities().connect(authority) };
    return this.requireRemoteConnections().loopAttempt(hostId, signal, force, user);
  }

  // A change only a new ssh session applies (agent forwarding): the connection ends, Damocles' master with it, and the host
  // connects again; its daemon and runs keep going meanwhile.
  private async reconnectFresh(hostId: string): Promise<void> {
    const host = this.hostStore?.host(hostId);
    if (!host) throw new Error(`No saved host ${hostId}`);
    const authority = this.authorityOfHost(hostId);
    // a loop attempt started before the cancelled one settled would join it and stop with its cancel
    await this.disconnectAuthority(authority);
    await this.exitHostControlMaster(hostId);
    this.reconnectHost(hostId);
  }

  private async exitHostControlMaster(hostId: string): Promise<void> {
    const plan = this.controlPlans.get(hostId);
    const host = this.hostStore?.sshHost(hostId);
    if (plan && host) await exitControlMaster(this.controlMasterDeps(), sshDestination(host.destination, (line) => log(line)), SSH_ENVIRONMENT.configFile, plan);
  }

  // Forget host: this computer's update flow, Damocles' master connection, session mirror, browser profile and
  // remote-state.json entries of the host.
  private forgetHostData(hostId: string): Promise<void> {
    const authority = this.authorityOfHost(hostId);
    return forgetHostData({
      dropEngine: async () => {
        // the shell's engines are read off remoteCores, and a forgotten host has no name to give its engine
        const remote = this.remoteCores.get(authority);
        this.remoteCores.delete(authority);
        this.pendingSwitches.forget(authority);
        this.switchReminders.forget(authority);
        this.missedDeadlines.delete(authority);
        this.sentChatConnection.delete(authority);
        this.sentHostAttention.delete(hostId);
        await remote?.dispose();
      },
      exitControlMaster: async () => {
        const plan = this.controlPlans.get(hostId);
        this.controlPlans.delete(hostId);
        const host = this.hostStore?.sshHost(hostId);
        if (plan && host) await exitControlMaster(this.controlMasterDeps(), sshDestination(host.destination, (line) => log(line)), SSH_ENVIRONMENT.configFile, plan);
      },
      mirrorIdle: async () => {
        const mirror = this.sessionMirrors.get(hostId);
        this.sessionMirrors.delete(hostId);
        await mirror?.idle();
      },
      mirrorFolder: path.join(this.userDataDir, 'remote', hostId),
      // its port attributes and restore entries leave with its host record
      forgetPorts: () => {
        this.ports?.forget(hostId);
        this.openUrl?.forgetHost(authority);
      },
      engineHalted: () => this.core.halted(),
      releaseBrowser: () => this.core.run('Forget host', (core) => core.client.releaseBrowser(authority)),
      profileFolder: path.join(DAMOCLES_HOME_DIR, 'browser-profiles', authority),
      forgetChats: () => {
        this.offlineQueue?.forgetAuthority(authority);
        this.lastChats.forgetAuthority(authority);
        this.forgetRelayedThemes(authority);
      },
      forgetForgeBindings: () => this.requireForgeHost().forgetHost(authority),
      forgetThemeLooks: () => this.core.run('Forget host', (core) => core.client.themesForgetHost(authority)),
      forgetRemoteState: () => this.requireRemoteState().forgetAuthority(authority),
      log: (line) => log(line),
    });
  }

  private controlMasterDeps(): ControlMasterDeps {
    return systemControlMasterDeps(path.join(DAMOCLES_HOME_DIR, 'ssh', 'cm'), () => this.sshClient(), (line) => log(line));
  }

  // The SSH client path setting, read at each ssh start; a user setting only, never a project's.
  private sshClient(): SshClientChoice {
    return sshClientChoice(this.requirePlatform().settings.get<unknown>(REMOTE_SSH_PATH_SETTING));
  }

  private async controlPlan(hostId: string, destination: SshDestination): Promise<ControlMasterPlan> {
    const plan = await controlMasterPlan(this.controlMasterDeps(), destination, SSH_ENVIRONMENT.configFile);
    this.controlPlans.set(hostId, plan);
    return plan;
  }

  // Damocles' masters would otherwise keep their authenticated connections for ControlPersist after the quit.
  private async exitControlMasters(): Promise<void> {
    await Promise.all([...this.controlPlans].map(async ([hostId, plan]) => {
      const host = this.hostStore?.sshHost(hostId);
      if (host) await exitControlMaster(this.controlMasterDeps(), sshDestination(host.destination, (line) => log(line)), SSH_ENVIRONMENT.configFile, plan);
    }));
  }

  // An authority's views the loop keeps reconnecting for: its editor tabs, terminals and chats, or the selected project.
  private hasOpenViews(authority: string): boolean {
    const of = (projectKey: string | undefined): boolean => projectKey !== undefined && authorityKeyOfProject(projectKey) === authority;
    if (of(this.selectedProjectKey)) return true;
    if (this.remoteChatViews(authority).length > 0) return true;
    if (this.editorPane?.hasProjectTab(of) || this.editorPane?.hasHostFileTab(authority)) return true;
    return this.remoteProjects().some((project) => project.authorityKey === authority && (this.terminals?.idsIn(project.key).length ?? 0) > 0);
  }

  // Each phase of the loop: terminals stop taking input on a drop and go on on a resume; the shell and chat pages follow.
  private reconnectEvent(event: ReconnectEvent): void {
    const authority = event.kind === 'gain' ? event.gain.authorityKey : event.authorityKey;
    if (event.kind === 'suspect' || event.kind === 'lost') {
      this.terminals?.connectionLost(authority);
      this.latency?.disconnected(authority);
      if (event.kind === 'lost') this.designPreviews?.connectionChanged(authority, false);
      this.offlineQueue?.hostLost(authority);
    }
    if (event.kind === 'permanent' && event.code === 'hostKeyChanged' && event.dropped) {
      const hostId = this.savedHostIdOf(authority);
      // the one failure that blocks: the security modal shows what changed and the command that removes the old key
      if (hostId !== undefined) this.openConnect(hostId);
    }
    if (event.kind === 'gain') {
      this.connectionGained(event.gain);
      this.designPreviews?.connectionChanged(authority, true);
    }
    this.overlaySettings?.authorityChanged(authority);
    this.shellStateChanged();
  }

  // The authority is usable again: resumed on the same connection, or attached fresh with its chats rejoined or restored.
  private connectionGained(gain: ConnectionGain): void {
    const authority = gain.authorityKey;
    const connection = this.authorities?.connection(authority);
    if (!connection) return;
    this.foreignViews.hostConnected(authority, connection.features);
    if (gain.how === 'resumed') this.terminals?.connectionResumed(authority);
    if (gain.how === 'attached') this.announceAway(authority, connection);
    if (connection.features.includes('control.ping')) this.latency?.connected(authority, connection);
    this.documents?.hostConnected(authority);
    // a fresh attach or a new core: what the earlier connection carried and core never answered may be lost
    if (gain.how === 'resumed') this.offlineQueue?.hostResumed(authority);
    else this.offlineQueue?.connectionEnded(authority);
    this.flushHeldMessages(authority);
    if (gain.restarted && !this.switchTold.has(connection)) this.hostRestarted(authority, gain.restarted);
  }

  /** The authorities whose project a visible, non-minimized window shows: only their latency is measured. */
  private setVisibleRemoteAuthorities(authorities: readonly string[]): void {
    this.latency?.setVisibleAuthorities(authorities);
  }

  private requireRemoteHosts(): RemoteHosts {
    if (!this.remoteHosts) throw new Error('Remote hosts used before startup finished');
    return this.remoteHosts;
  }

  // The saved SSH hosts: their attempts over ssh, and the Connect dialog's actions on them.
  private startRemoteHosts(store: HostStore): void {
    const install = this.serverInstall;
    this.remoteConnections = new RemoteConnections({
      host: (hostId) => store.host(hostId),
      startSsh: async ({ host, signal, userStarted, hooks, savePlatform, installFolderSettled }) => {
        const { manifest, artifacts, releasesUrl, askpass } = await install();
        const destination = sshDestination(host.destination, (line) => log(line));
        const plan = await this.controlPlan(host.id, destination);
        return startSshTransport({
          destination,
          ...(host.osOverride !== undefined ? { osOverride: host.osOverride } : {}),
          ...(host.platform !== undefined ? { cachedPlatform: host.platform } : {}),
          ...(host.settings.installFolder !== undefined ? { installFolder: host.settings.installFolder } : {}),
          ...(host.previousInstallFolder !== undefined ? { previousInstallFolder: host.previousInstallFolder } : {}),
          forwardAgent: forwardsAgent(host),
          ...(host.identityFile !== undefined ? { identityFile: host.identityFile } : {}),
          ...this.rememberedOption(host),
          signal,
          userStarted,
          hooks,
          savePlatform,
          installFolderSettled,
          askpass,
          manifest,
          ...(releasesUrl !== undefined ? { releasesUrl } : {}),
          artifacts,
          ...(SSH_ENVIRONMENT.configFile !== undefined ? { sshConfigFile: SSH_ENVIRONMENT.configFile } : {}),
          controlMaster: plan,
          hostLabel: host.name,
          log: (line) => log(`[ssh ${host.id}] ${line}`),
        }, systemSshTransportDeps(() => this.sshClient()));
      },
      startWsl: async ({ host, signal, userStarted, hooks, installFolderSettled }) => {
        const { manifest, artifacts, releasesUrl } = await install();
        return startWslTransport({
          distro: host.distro,
          // the list also gives the distro's version, which decides whether it shares this computer's loopback
          listed: () => this.requireRemoteHosts().distroListing(host.distro),
          ...(host.settings.installFolder !== undefined ? { installFolder: host.settings.installFolder } : {}),
          ...(host.previousInstallFolder !== undefined ? { previousInstallFolder: host.previousInstallFolder } : {}),
          signal,
          userStarted,
          hooks,
          installFolderSettled,
          manifest,
          ...(releasesUrl !== undefined ? { releasesUrl } : {}),
          artifacts,
          log: (line) => log(`[wsl ${host.id}] ${line}`),
        });
      },
      startContainer: async ({ host, signal, userStarted, hooks, watched, installFolderSettled }) => connectContainer({
        side: this.containerSide(host.via, install),
        install,
        gate: () => this.containerTrustGate(host.id, install, signal, watched),
        recordContainer: (found) => store.recordContainer(host.id, found),
        dataVolumeMissing: () => this.notifyContainerWithoutDataVolume(host.id),
        hooks,
        signal,
        userStarted,
        watched,
        installFolderSettled,
        log: (line) => log(`[container ${host.id}] ${line}`),
      }, host),
      savePlatform: (hostId, platform) => store.savePlatform(hostId, platform),
      installFolderSettled: (hostId) => store.installFolderSettled(hostId),
      connect: (hostId) => this.requireAuthorities().connect(this.authorityOfHost(hostId)),
      connection: (hostId) => {
        const authority = this.authorityOfHost(hostId);
        const held = this.authorities?.heldConnection(authority);
        if (!held || held.lost()) return undefined;
        return this.authorities?.connection(authority) ? 'usable' : 'suspect';
      },
      changed: (hostId) => {
        const failure = this.remoteConnections?.failure(hostId);
        if (failure?.code === 'belowFloor' && typeof failure.params['floor'] === 'string') this.belowFloor(this.authorityOfHost(hostId), failure.params['floor']);
        // the reconnect loop stops here as after Disconnect: only a connect the user starts installs the server again
        if (failure?.code === 'serverRemoved' && this.authorities?.state(this.authorityOfHost(hostId)) !== 'offline') void this.disconnectAuthority(this.authorityOfHost(hostId));
        this.remoteHosts?.hostChanged(hostId);
        this.reconnector?.attemptChanged(this.authorityOfHost(hostId));
        this.shellStateChanged();
        for (const listener of [...this.hostNoticeListeners]) listener(hostId);
      },
      log: (line) => log(line),
    });
    this.remoteHosts = new RemoteHosts({
      store,
      heldMemory: (authorityKey) => {
        const client = this.authorities?.connection(authorityKey)?.features.includes(HELD_MEMORY_FEATURE) ? this.remoteCores.get(authorityKey)?.host.current()?.client : undefined;
        return client && { queues: () => client.heldMemoryQueues(), deliver: (queueId) => client.deliverHeldMemory(queueId), discard: (queueId) => client.discardHeldMemory(queueId) };
      },
      connections: this.remoteConnections,
      state: (authorityKey) => this.requireAuthorities().state(authorityKey),
      connection: (authorityKey) => this.authorities?.connection(authorityKey),
      workspace: (authorityKey) => this.authorities?.connectedWorkspace(authorityKey),
      terminals: {
        canOpen: (authorityKey, terminal) => this.terminals?.canOpen(authorityKey, terminal) === true,
        open: (authorityKey, id) => this.openHostTerminal(authorityKey, id),
        notResponding: (authorityKey) => this.terminals?.notResponding(authorityKey) ?? [],
      },
      projects: (hostId) => this.remoteProjects().filter((project) => project.authorityKey === this.authorityOfHost(hostId)),
      pickRoots: (authorityKey) => {
        const projects = this.remoteProjects().filter((project) => project.authorityKey === authorityKey);
        return [...projects, ...this.remoteFileRoots(authorityKey).filter((root) => !projects.some((project) => project.key === root.key))];
      },
      hostName: (authorityKey) => this.hostName(authorityKey),
      update: (authorityKey) => this.pendingSwitches.get(authorityKey)?.update(),
      serverInUse: (authorityKey) => this.serverInUse(authorityKey),
      canCheckForUpdates: () => this.canCheckForUpdates(),
      updateAction: (hostId, action) => this.hostUpdateAction(hostId, action),
      confirmEndTerminalHost: async (hostId, titles) => {
        const localization = this.requireLocalization();
        const answer = await this.ask(endTerminalHostQuestion(this.hostName(this.authorityOfHost(hostId)), titles, (message, ...args) => localization.t(message, ...args)));
        log(`[remote] ${hostId}: End terminal host of ${titles.length} terminals: ${answer === 0 ? 'confirmed' : 'cancelled'}`);
        return answer === 0;
      },
      parse: (input) => parseSshCommand(input),
      // ssh reads ~/.ssh/config from the passwd entry's home, never HOME
      sshConfigAliases: () => configuredAliases(SSH_ENVIRONMENT, process.platform, process.env, (line) => log(line)),
      validInstallFolder: (folder) => validateInstallFolder(folder).ok,
      addProject: (hostId, folder) => this.addRemoteProject(this.authorityOfHost(hostId), folder),
      showLogs: (hostId) => this.showHostLogs(hostId),
      writeClipboard: (text) => this.requirePlatform().clipboard.writeText(text),
      overlay: () => {
        const overlay = this.overlay;
        return overlay && {
          request: (request: OverlayRequest, shown?: () => void, signal?: AbortSignal) => overlay.request(request, webContents.getFocusedWebContents() ?? undefined, shown, undefined, signal),
          send: (channel: string, payload: unknown) => overlay.send(channel, payload),
          isOpen: (kind: 'connect' | 'settings') => overlay.isOpen(kind),
        };
      },
      renamed: (hostId, previousName) => this.hostRenamed(hostId, previousName),
      policyChanged: (hostId) => {
        const authority = this.authorityOfHost(hostId);
        this.userRelays?.policyChanged(authority);
        this.agentRelays?.policyChanged(authority);
      },
      reconnectFresh: (hostId) => this.reconnectFresh(hostId),
      deleteRememberedSecrets: (hostId) => this.rememberedSecrets().deleteAllForHost(hostId),
      forgetLocalData: (hostId) => this.forgetHostData(hostId),
      confirmCloseTabs: async (hostIds) => {
        const editor = this.editorPane;
        if (!editor) return () => undefined;
        const authorities = hostIds.map((hostId) => this.authorityOfHost(hostId));
        const answers = await editor.confirmCloseHosts(authorities);
        return answers && (() => {
          if (!editor.closeHosts(authorities, answers)) log(`[remote] the forgotten host's tabs stay open: one was edited after its question`);
        });
      },
      disconnect: (hostId) => this.disconnectAuthority(this.authorityOfHost(hostId)),
      exitControlMaster: (hostId) => this.exitHostControlMaster(hostId),
      openSettings: (hostId) => this.openSettings({ section: 'remoteHosts', host: hostId }),
      keySetup: {
        folder: keyFolder(DAMOCLES_HOME_DIR),
        clientName: os.hostname(),
        resolveKeygen: () => resolveSshKeygenExecutable(process.env, process.platform, this.sshClient()),
        resolveSsh: () => resolveSshExecutable(process.env, process.platform, this.sshClient()),
        run: (spec, options) => runProcess(spec, options),
        sshQuery: runSsh,
        askpass: async () => this.mainAskpass(),
        sshVersion: (ssh) => sshVersion(ssh),
        env: process.env,
        log: (line) => log(line),
      },
      ...(SSH_ENVIRONMENT.configFile !== undefined ? { sshConfigFile: SSH_ENVIRONMENT.configFile } : {}),
      runRemovalStage: (hostId, script) => this.requireRemoteConnections().withPrompts(hostId, async (prompt, signal) => {
        const { askpass } = await install();
        const host = store.sshHost(hostId);
        const targetOs = host && hostOs(host);
        if (!host || targetOs === undefined) throw new Error(`No platform is known for the host ${hostId}`);
        const destination = sshDestination(host.destination, (line) => log(line));
        const plan = await this.controlPlan(hostId, destination);
        return runSshStage({
          hostLabel: host.name,
          destination,
          platform: { os: targetOs, ...(host.platform?.windowsShell !== undefined ? { windowsShell: host.platform.windowsShell } : {}) },
          ...(host.identityFile !== undefined ? { identityFile: host.identityFile } : {}),
          ...(SSH_ENVIRONMENT.configFile !== undefined ? { sshConfigFile: SSH_ENVIRONMENT.configFile } : {}),
          controlMaster: plan,
          ...this.rememberedOption(host),
          askpass,
          prompt,
          signal,
          log: (line) => log(`[ssh ${hostId}] ${line}`),
        }, script, systemSshTransportDeps(() => this.sshClient()));
      }),
      reconnect: (authorityKey) => this.reconnectPhaseOf(authorityKey),
      latency: (authorityKey) => this.latency?.latency(authorityKey),
      watchLimit: (authorityKey) => this.watchLimits.notice(authorityKey, this.authorities?.connection(authorityKey)),
      sharedHome: (authorityKey) => this.sharedHomes.notice(authorityKey, this.authorities?.connection(authorityKey)),
      listDistros: () => listWslDistros(),
      setWslVersion: systemSetVersion(),
      containerSide: (via) => this.containerSide(via, install),
      cliFolderKey: async (via, target) => (via === undefined ? folderKey(target) : this.requireConnection(this.authorityOfHost(via)).workspace.request('files.folderKey', { path: target })),
      containerEngine: () => {
        const value = this.requirePlatform().settings.get<unknown>(REMOTE_CONTAINER_ENGINE_SETTING);
        return isDesktopSettingValue(REMOTE_CONTAINER_ENGINE_SETTING, value) ? (value as 'docker' | 'podman') : 'docker';
      },
      pickLocalFolder: () => {
        const platform = this.requirePlatform();
        return platform.nativeDialogs.pickFolder({ title: platform.localization.t('Open a Folder in a Container') });
      },
      containerGate: (hostId) => {
        const record = this.containerRecord(hostId);
        // Rebuild runs after the user confirmed it and has no cancel
        return passGate(() => this.containerTrustGate(hostId, install, new AbortController().signal, () => true), record.workspaceFolder!);
      },
      containerUp: async (hostId, removeExisting, onLog) => {
        const record = this.containerRecord(hostId);
        await upContainer({ side: this.containerSide(record.via, install), recordContainer: (found) => store.recordContainer(hostId, found), dataVolumeMissing: () => this.notifyContainerWithoutDataVolume(hostId), signal: new AbortController().signal, log: (line) => log(line) }, record, removeExisting, onLog);
      },
      openContainerFolder: (hostId) => this.openContainerFolder(hostId),
      log: (line) => log(line),
    });
    this.disposables.push(store.onDidChange(() => this.remoteHosts?.hostsChanged()));
  }

  private async readServerInstall(): Promise<ServerInstall> {
    const platform = this.requirePlatform();
    const found = await readServerManifest(__dirname, platform.appInfo.version, app.isPackaged);
    if ('refused' in found) throw new Error(`No server package can be installed: ${found.detail}`);
    const releasesUrl = releasesUrlOf(found.manifest, SSH_ENVIRONMENT.releasesUrl);
    if (releasesUrl === undefined) log('[remote] this build\'s server manifest is unpublished: hosts get its packages from this computer and never download them');
    const artifacts = createArtifactCache({
      cacheRoot: path.join(this.userDataDir, 'server-cache'),
      manifest: found.manifest,
      ...(releasesUrl !== undefined ? { releasesUrl } : {}),
      ...(app.isPackaged ? {} : { devDir: path.join(resourceRoot, 'dist', 'server-packages') }),
      fetch: (url, init) => net.fetch(url, { signal: init.signal }),
      log: (line) => log(line),
    });
    // the e2e hooks install and run another version, which a test placed on the target itself
    const manifest = REMOTE_E2E.appVersion === undefined && REMOTE_E2E.requirement === undefined ? found.manifest : e2eManifest(found.manifest, REMOTE_E2E.appVersion, REMOTE_E2E.requirement);
    return { manifest, artifacts, ...(releasesUrl !== undefined ? { releasesUrl } : {}), askpass: this.mainAskpass() };
  }

  // A target's git credential relay: consent in the overlay, then this computer's own `git credential fill`.
  private gitCredentialClient(): GitCredentialClient {
    this.gitCredentials ??= createGitCredentialClient({
      host: (hostId) => {
        const record = this.hostStore?.host(hostId);
        return record && { name: record.name, ...(record.color !== undefined ? { color: record.color } : {}), alwaysCredentialHosts: record.alwaysCredentialHosts ?? [], alwaysForgeAccounts: record.alwaysForgeAccounts ?? [] };
      },
      forge: {
        answer: (request, origin, authorityKey, projectKey, consentedAccountId, signal) => this.core.run('Answering a remote host\'s git credential request', (core) => core.client.forgeGitCredential({
          request, origin, authorityKey, ...(projectKey !== undefined ? { projectKey } : {}), ...(consentedAccountId !== undefined ? { consentedAccountId } : {}),
        }, signal)),
        authorityKey: (hostId) => this.authorityOfHost(hostId),
        projectOf: (hostId, targetProjectKey, cwd) => {
          const authority = this.authorityOfHost(hostId);
          const roots = this.roots.all().filter((root) => authorityKeyOfProject(root.root.projectKey) === authority);
          if (targetProjectKey !== undefined) {
            const key = `${authority}|${targetProjectKey}`;
            return roots.some((root) => root.root.projectKey === key) ? key : undefined;
          }
          const os = this.knownAuthorityOs(authority);
          if (cwd === undefined || os === undefined) return undefined;
          // git -C <project> runs the helper in the project's own folder, which holding (strictly below a root) passes over
          const at = folderKeyOn(os, cwd);
          const own = roots.find((root) => folderKeyOn(os, root.fsPath) === at);
          return own?.root.projectKey ?? this.rootSpellings.holding({ authority, os }, roots, cwd)?.root.root.projectKey;
        },
      },
      addAlways: (hostId, credentialHost) => this.requireHostStore().addAlwaysCredentialHost(hostId, credentialHost),
      revokeAlways: (hostId, credentialHost) => this.requireHostStore().revokeCredentialHost(hostId, credentialHost),
      addAlwaysAccount: (hostId, account) => this.requireHostStore().addAlwaysForgeAccount(hostId, account),
      askConsent: async (consent, signal) => {
        const request = parseGitCredentialConsentRequest(consent);
        const overlay = this.overlay;
        if (!request || !overlay) {
          log(`[git-credential] the consent dialog cannot show (${request ? 'no overlay' : 'past its bounds'}); the credential is refused`);
          return 'deny';
        }
        this.revealWindow();
        return gitCredentialConsentChoice(await overlay.request(request, webContents.getFocusedWebContents() ?? undefined, undefined, undefined, signal));
      },
      gitCredential: clientGitCredential({
        git: () => (this.gitProbe.available ? this.gitProbe.path : undefined),
        run: async (spec, input, signal) => {
          const { exit, stdout } = await runProcess({ file: spec.file, args: [...spec.args], cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, { input, ...(signal ? { signal } : {}) });
          return { code: exit?.code ?? null, stdout: stdout.toString('utf8') };
        },
        askpassEnv: async () => {
          const ask = this.askCredential;
          if (!ask) throw new Error('The askpass bridge is not ready');
          return this.mainAskpass().register('interactive', 'git credential', async (prompt, signal) => {
            const answer = await ask(prompt, signal);
            return answer.cancelled ? PROMPT_CANCELLED : answer.answer;
          });
        },
      }),
      notify: (message, action) => this.notifications.warn(message, action),
      t: (message, ...args) => this.requireLocalization().t(message, ...args),
      log: (line) => log(line),
    });
    return this.gitCredentials;
  }

  private rememberedSecrets(): RememberedSecrets {
    this.sshRememberedSecrets ??= createRememberedSecrets(this.requirePlatform().secrets);
    return this.sshRememberedSecrets;
  }

  // the host's remembered answers for an ssh call, only while its Remember password setting is on
  private rememberedOption(host: SshHostRecord): { readonly remembered?: RememberedOption } {
    return host.settings.rememberPassword === true ? { remembered: { offer: true, secrets: this.rememberedSecrets().forHost(host.id) } } : {};
  }

  // A local terminal's git credential takeover (docs/invariants.md "GitHub and GitLab accounts"): one credential registration per
  // shell process, answered by the local core; nothing while no server has an account.
  private async terminalGitCredentials(projectKey: string | null, inherited: string | undefined): Promise<TerminalGitCredentials | undefined> {
    this.managedServers = await terminalManagedServers(this.client(), this.managedServers);
    const appPaths = createDesktopAppPaths(layout);
    if (this.managedServers.length === 0) return undefined;
    const params = asConfigParams(managedEntries(this.managedServers, credentialHelperPath(appPaths.unpackedRoot)), inherited);
    if (params === undefined) return undefined;
    this.terminalAskpass ??= createAskpassServer({
      paths: askpassPaths(appPaths, process.execPath),
      // a credential registration never prompts
      prompt: async () => PROMPT_CANCELLED,
      credential: async (request, origin, signal) => {
        const running = this.client();
        if (!running) throw new Error('Damocles Core is not running, so a terminal\'s git credential request could not be answered');
        const result = await running.forgeGitCredential({ request, origin, authorityKey: 'local' }, signal);
        if ('consent' in result) throw new Error('A terminal\'s git credential request on this computer asked for a relay consent');
        return result.answer;
      },
      log: (line) => log(`[terminal-git] ${line}`),
    });
    const project = projectKey === null ? undefined : (parseRootKey(projectKey)?.projectKey ?? projectKey);
    const registration = await this.terminalAskpass.registerCredential({ kind: 'terminal', ...(project !== undefined ? { projectKey: project } : {}) });
    return { env: { ...registration.env, GIT_CONFIG_PARAMETERS: params }, dispose: () => registration.dispose() };
  }

  private mainAskpass(): AskpassServer {
    this.sshAskpass ??= createMainAskpassServer({ paths: askpassPaths(createDesktopAppPaths(layout), process.execPath), log: (line) => log(line) });
    return this.sshAskpass;
  }

  // The Ports section and its forwards, one TunnelManager for every remote host and the loopback daemon.
  private startPorts(platform: DesktopPlatform, localization: DesktopLocalizationService): PortsController {
    const setting = <T>(key: string): T => {
      const value = platform.settings.get<unknown>(key);
      return (isDesktopSettingValue(key, value) ? value : DESKTOP_CONFIGURATION[key]!.default) as T;
    };
    const ports = new PortsController({
      hostStore: this.requireHostStore(),
      clientPlatform: process.platform,
      connection: (authority) => this.authorities?.connection(authority),
      autoForward: () => setting<boolean>(REMOTE_AUTO_FORWARD_PORTS_SETTING),
      fallbackThreshold: () => setting<number>(REMOTE_AUTO_FORWARD_PORTS_FALLBACK_SETTING),
      projectsOf: (hostId) => this.remoteProjects().filter((project) => project.authorityKey === this.portsHostAuthority(hostId)).map((project) => project.key),
      isProject: (projectKey) => this.remoteProject(projectKey) !== undefined,
      hostName: (hostId) => this.hostName(this.portsHostAuthority(hostId)),
      notice: (hostId, severity, title, message, actions) => this.notificationCenter.notice(severity, message, actions, this.notificationHost(this.portsHostAuthority(hostId)), title),
      openInPane: (projectKey, hostId, url) => this.openPortInPane(projectKey, hostId, url),
      openExternal: (url) => platform.shell.openExternal(url),
      copy: (text) => platform.clipboard.writeText(text),
      askInput: createInputAsker({
        overlay: () => this.overlay,
        focused: () => webContents.getFocusedWebContents() ?? undefined,
        unavailable: () => void this.notifications.error(localization.t('The text box could not be shown, so nothing was changed. Try again.')),
        log: (line) => log(line),
      }),
      t: (message, ...args) => localization.t(message, ...args),
      ...(process.platform === 'win32' ? {
        probe: (port, nonce) => probeLoopback(port, nonce),
        windowsListeners: () => systemWindowsListeners(),
        accepted: (host, port) => acceptedWithin(host, port),
        networkingMode: (distro) => wslNetworkingMode(distro),
      } : {}),
      servedPorts: (authority) => this.servedRoots.servedPorts(authority),
      onServedChange: (listener) => this.servedRoots.onDidChange(listener),
      log: (line) => log(line),
    });
    this.portsView = ports.onView((view) => this.shell?.portsView(view));
    return ports;
  }

  // A command-line request (docs/invariants.md "The damocles command"), handled once the window shows the launch's tabs.
  private takeCommandLine(argv: readonly string[]): void {
    const quitting = this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'done';
    this.requireCliRequests().fromArgv(optionArgs(argv), this.windowReady, quitting).catch(this.report('A damocles command'));
  }

  private requireCliRequests(): CliRequests {
    this.cliRequests ??= new CliRequests(this.cliRequestsDeps());
    return this.cliRequests;
  }

  // Built at the first command line's request, which can come before localization is ready, so t reads it at each call.
  private cliRequestsDeps(): ConstructorParameters<typeof CliRequests>[0] {
    const t = (message: string, ...args: string[]): string => this.requireLocalization().t(message, ...args);
    const files = (authorityKey: string): ProjectWorkspace['files'] => (authorityKey === 'local' ? this.requireWorkspaces().local : this.remoteWorkspace(authorityKey)).files;
    const opening = (): OpenAsProjectDeps => this.projectOpening();
    return {
      projects: (authorityKey) => this.workspaceProjects().filter((project) => authorityKeyOfProject(project.key) === authorityKey),
      spellings: this.rootSpellings,
      os: (authorityKey) => this.authorityOs(authorityKey),
      hostName: (authorityKey) => this.hostName(authorityKey),
      isDirectory: (authorityKey, folder) => files(authorityKey).isDirectory(folder),
      confineExisting: (authorityKey, project, relativePath, rule) => files(authorityKey).confineExisting(project, relativePath, rule),
      confineMissing: (authorityKey, project, relativePath, rule) => files(authorityKey).confineMissing(project, relativePath, rule),
      read: (authorityKey, file) => files(authorityKey).read(file, EDITOR_CONFIRM_DOCUMENT_BYTES),
      resolveOutside: (authorityKey, target) => files(authorityKey).resolveOutside(target),
      readOutside: (authorityKey, file) => files(authorityKey).readOutside(file),
      folderProject: async (authorityKey, folder) => {
        const projectKey = await opening().projectKeyOf(authorityKey, folder);
        return { projectKey, listed: opening().isProject(projectKey) };
      },
      // the damocles command the user ran
      selectProject: (projectKey) => this.selectProject(projectKey, true),
      addFolder: async (authorityKey, folder) => {
        await openFolderAsProject(opening(), authorityKey, folder);
      },
      confirm: async (question, action, focusAction) => (await this.ask({ severity: 'info', message: question, actions: [action], cancelLabel: t('Cancel'), ...(focusAction ? { defaultAction: 0 } : {}) })) === 0,
      openNamed: (authorityKey, filePath, position) => this.requireEditorPane().openNamedPath(authorityKey, filePath, { ...position, focus: true }),
      showPatch: (tab) => this.requireEditorPane().showPatch(tab, { focus: true }),
      whenClosed: (tabId) => this.requireEditorPane().whenClosed(tabId),
      showWindow: () => this.showWindow(),
      openExternal: async (authorityKey, url) => {
        try {
          await this.requireOpenUrl().terminalBrowser(authorityKey, url);
        } catch (err) {
          if (err instanceof LinkRefusedError) throw new CliRefusal(t('damocles: {0}', err.message));
          throw err;
        }
      },
      resolveRemote: (spec) => resolveRemoteSpec(spec, this.requireHostStore().hosts(), LOOPBACK),
      connect: async (target) => {
        const deps = this.openInDistroDeps();
        if (target.kind === 'wsl') {
          const host = await deps.distroHost(target.distro);
          if (!host) throw new CliRefusal(t('damocles: WSL lists no distro called {0}.', target.distro));
          await deps.connect(host.hostId);
          return host.authorityKey;
        }
        // the loopback daemon has no host record
        if (target.hostId === undefined) await this.requireAuthorities().connect(target.authorityKey);
        else await deps.connect(target.hostId);
        return target.authorityKey;
      },
      openConnect: async (query) => {
        this.showWindow();
        this.requireRemoteHosts().openConnect(undefined, { query }).catch(this.shellFailure('Connect to Host', 'Damocles could not open the Connect dialog: {0}'));
      },
      notify: (message) => void this.notifications.warn(message),
      claimWaitMarker: (marker) => claimWaitMarker(marker, waitMarkerFolder(DAMOCLES_HOME_DIR), process.pid),
      deleteWaitMarker: (marker) => deleteWaitMarker(marker, waitMarkerFolder(DAMOCLES_HOME_DIR)),
      t,
      render: (text) => this.requireLocalization().render(text),
      log: (line) => log(line),
    };
  }

  // Links from targets (docs/invariants.md "Links from targets"): one checker for every terminal, chat page and remote core.
  private requireOpenUrl(): OpenUrl {
    this.openUrl ??= new OpenUrl({
      tunnels: (authority) => this.requirePorts().forwarding.forwardingFor(this.hostIdOf(authority)),
      onForwardsChanged: (listener) => {
        const tunnels = this.requirePorts().tunnels;
        return tunnels.onDidChange((authority) => listener(authority, tunnels.list(authority).map((tunnel) => tunnel.localPort)));
      },
      opensTerminalLinks: (authority) => {
        const hostId = this.savedHostIdOf(authority);
        return hostId !== undefined && this.hostStore?.host(hostId)?.settings.openLinksWithoutAsking === true;
      },
      askToOpen: ({ authority, url }) => this.notificationCenter.linkRequest(this.notificationHost(authority), url),
      openExternal: (url) => this.requirePlatform().shell.openExternal(url),
      refusalText: (code, port) => this.requirePorts().refusalText(code, port),
      hostName: (authority) => this.hostName(authority),
      warn: (message) => void this.notifications.warn(message),
      t: (message, ...args) => this.requireLocalization().t(message, ...args),
      log: (line) => log(line),
    });
    return this.openUrl;
  }

  private requirePorts(): PortsController {
    if (!this.ports) throw new Error('Ports used before startup finished');
    return this.ports;
  }

  // The project root a chat view of the authority works in, as main lists it: its project folder, or its live chat worktree;
  // never the default target or a path its core names.
  private servedProjectOf(authority: string, viewId: string): Project | undefined {
    const panel = this.chatViewOf(authority, viewId);
    if (!panel) return undefined;
    const folder = this.clientOf(panel)?.chatOfView(panel.panelId)?.folder;
    if (!folder) return undefined;
    if (folder.ownerKey === undefined) return this.roots.projectRoots().find((root) => root.key === folder.key);
    const event = this.worktreeEventOf(panel);
    return event?.worktreeId !== undefined && event.state.place === 'worktree' ? this.roots.ofWorktree(event.worktreeId, authority) : undefined;
  }

  // a live chat view of the authority that main shows
  private chatViewOf(authority: string, viewId: string): DesktopPanel | undefined {
    const panel = this.views?.panel(viewId);
    return panel && panel.kind === 'chat' && !panel.isDisposed && panel.authority === authority && this.views?.chats().includes(panel) ? panel : undefined;
  }

  // browser.servedFileUrl of the local core: a root file of one of its chat views, on that root's served origin.
  private async servedFile(request: CoreRequests['browser.servedFileUrl']['params']): Promise<CoreRequests['browser.servedFileUrl']['result']> {
    const root = request.kind === 'project' ? { kind: 'project' as const } : request.kind === 'design' ? { kind: 'design' as const, designId: request.designId } : { kind: 'folder' as const, folder: request.folder };
    const refusal = servedPathRefusal(root.kind === 'folder' ? { kind: 'folder' } : root, request.relPath);
    if (refusal !== undefined) return { refused: refusal };
    const grant = await this.servedRoots.grant({ authority: 'local', root, viewId: request.viewId });
    return 'refused' in grant ? grant : { url: grant.open(request.relPath), origin: grant.origin };
  }

  // the host's forwarded local ports and its switch, as its browser context's proxy applies them
  private clientNetworkPolicy(authority: string): { readonly allowedPorts: readonly number[]; readonly allowLocalNetwork: boolean } {
    return this.requirePorts().clientNetworks()[authority] ?? { allowedPorts: [], allowLocalNetwork: false };
  }

  // Open in pane: a page of the project's selected chat (else its most recent one; for a host, any chat of it) at url.
  private async openPortInPane(projectKey: string | undefined, hostId: string, url: string): Promise<void> {
    const authority = this.portsHostAuthority(hostId);
    const { t } = this.requireLocalization();
    if (!this.browserEnabled()) {
      const open = t('Open Settings');
      if ((await this.notifications.info(t('The browser is off. Turn it on in Settings to open pages in the pane.'), open)) === open) this.openSettings({ section: 'integrations' });
      return;
    }
    const views = this.requireViews();
    const fits = (chat: DesktopPanel): boolean => chat.authority === authority && (projectKey === undefined || this.projectOf(chat) === projectKey);
    const selected = views.selected();
    const chat = selected && fits(selected) ? selected : [...views.chats()].filter(fits).sort((a, b) => (this.lastViewed.get(b) ?? 0) - (this.lastViewed.get(a) ?? 0))[0];
    if (!chat) {
      void this.notifications.info(this.requireLocalization().t('Open a chat on {0} to show the page in its pane.', this.hostName(authority)));
      return;
    }
    await this.foreignViews.attachView(chat.panelId, authority);
    await this.core.run('Open in pane', (core) => core.client.newBrowserPage(chat.panelId, url));
    this.showChat(chat, { focus: true });
  }

  // A remote chat's typed address: on its local forward when it names the target's loopback, then the client-network guard.
  private async remotePageAddress(chat: DesktopPanel, url: string): Promise<string | undefined> {
    let verdict: Awaited<ReturnType<typeof typedRemoteAddress>>;
    try {
      verdict = await typedRemoteAddress(url, chat.authority, this.requirePorts().forwarding.forwardingFor(this.hostIdOf(chat.authority)), () => this.clientNetworkPolicy(chat.authority), this.servedRoots.viewOrigins(chat.authority, chat.panelId));
    } catch (err) {
      // a forward the address needs and cannot have is told, never a typed address that does nothing
      log(`[browser] ${chat.authority}: a typed address could not be forwarded — ${err instanceof Error ? err.message : String(err)}`);
      void this.notifications.warn(this.requireLocalization().t('The address could not be forwarded from {0} to this computer.', this.hostName(chat.authority)));
      return undefined;
    }
    if (verdict.allowed) return verdict.url;
    void this.notifications.warn(this.requireLocalization().render(verdict.reason));
    return undefined;
  }

  // The chip of a remote chat's page on a forwarded port: its host and the address as the target names it.
  private forwardedFrom(chat: DesktopPanel, url: string): ShellBrowserPage['forwardedFrom'] {
    const hostId = chat.authority === LOOPBACK_HOST ? LOOPBACK_HOST : this.savedHostIdOf(chat.authority);
    if (hostId === undefined || !URL.canParse(url)) return undefined;
    const tunnels = this.requirePorts().tunnels.list(chat.authority);
    const parsed = new URL(url);
    if (!tunnels.some((tunnel) => String(tunnel.localPort) === parsed.port)) return undefined;
    const color = this.hostColor(chat.authority);
    return { hostId, hostName: this.hostName(chat.authority), ...(color !== undefined ? { hostColor: color } : {}), targetUrl: rewriteOutbound(url, tunnels) };
  }

  // A connected saved host (SSH, WSL or container): its use is recorded and its session mirror catches up.
  private hostConnected(hostId: string, connection: RemoteConnection): void {
    this.hostStore?.touchHost(hostId).catch(this.report('Recording when a host was used'));
    this.ports?.connected(hostId, connection);
    if (this.hostStore?.host(hostId)?.kind === 'container') this.agentRelays?.attach(this.authorityOfHost(hostId), connection);
    const following = followMirrorChanges(connection, () => this.syncMirror(hostId, connection));
    const removing = connection.onRemoving((deviceName) => this.serverRemovedElsewhere(hostId, deviceName));
    // a daemon that names another device's switch lists this device's own runs, which the switch's notice counts
    const ownRuns = connection.features.includes(HANDING_OVER_FEATURE) ? followOwnRuns(connection, (line) => log(line)) : undefined;
    const handingOver = connection.onHandingOver((deviceName) => this.handingOverElsewhere(hostId, connection, deviceName, ownRuns?.count() ?? 0));
    connection.onClose(() => {
      following.dispose();
      removing.dispose();
      ownRuns?.dispose();
      handingOver.dispose();
    });
    this.syncMirror(hostId, connection);
  }

  // Another device removed the host's server: the host goes offline as it does after this device's own removal, so nothing
  // reconnects and installs it again, and it says by whom until the user connects.
  private serverRemovedElsewhere(hostId: string, deviceName: string): void {
    const authority = this.authorityOfHost(hostId);
    log(`[remote] ${hostId}: ${deviceName} removes the Damocles server; the host goes offline`);
    this.requireRemoteConnections().markRemoved(hostId, deviceName);
    void this.disconnectAuthority(authority);
    const { t } = this.requireLocalization();
    this.notificationCenter.notice('warning', t('The Damocles server on {0} was removed from {1}. Connect to install it again.', this.hostName(authority), deviceName), [t('Connect')], this.notificationHost(authority)).then((answer) => {
      if (answer === 0) this.reconnectHost(hostId);
    }).catch(this.shellFailure('Connect', 'Damocles could not reconnect to the host: {0}'));
  }

  // Another device's switch ends the host's daemon: the next attach that finds another version says who switched it and how many
  // of this device's own agent runs (listOwnRuns, as of the latest runs event) it stopped.
  private handingOverElsewhere(hostId: string, connection: RemoteConnection, deviceName: string, agentsStopped: number): void {
    const authority = this.authorityOfHost(hostId);
    log(`[update] ${authority}: ${deviceName} switches the daemon of ${connection.serverVersion}; ${agentsStopped} of this device's agents stop`);
    this.switchReminders.handingOver(authority, { deviceName, agentsStopped, serverVersion: connection.serverVersion });
  }

  // A fresh connection's chats reopened: the chats left running at the last detach that ended meanwhile make one notice.
  private announceAway(authority: string, connection: RemoteConnection): void {
    announceFinishedAway({
      recorded: (key) => this.requireRemoteState().away(key),
      record: (key, chats) => this.requireRemoteState().setAway(key, chats, this.remoteCores.get(key)?.epoch() ?? null),
      runs: async () => (await connection.control.request('listRuns', {})).runs,
      coreRestarted: (key) => {
        const ran = this.requireRemoteState().awayEpoch(key);
        const now = this.remoteCores.get(key)?.epoch() ?? null;
        return ran !== null && now !== null && now !== ran;
      },
      hostName: (key) => this.hostName(key),
      t: (message, ...args) => this.requireLocalization().t(message, ...args),
      notify: (message, actions, key) => this.notificationCenter.notice('info', message, actions, this.notificationHost(key)),
      open: async (key, chat) => {
        await this.selectChat(chat.sessionId, key);
      },
      log: (line) => log(line),
    }, authority).catch(this.report('Telling which chats finished while away'));
  }

  // A saved host's daemon of the same protocol and another build, before the connection is published (adoptCompatibleDaemon).
  // A check that fails keeps the daemon; either way this connection settles the switch the one before waited for.
  private async adoptDaemonVersion(authority: string, connection: RemoteConnection): Promise<'kept' | 'replaced'> {
    // the loopback daemon has no host record and runs this app's own build
    if (this.savedHostIdOf(authority) === undefined) return 'kept';
    // a switch's own notice tells this restart
    if (this.switchReminders.arrived(authority, connection.serverVersion)) this.switchTold.add(connection);
    try {
      // the manifest every saved host's connect installs from
      const { manifest } = await this.serverInstall();
      const required = await this.requiredDeadlineOf(authority, manifest, connection.serverVersion);
      const adopted = await adoptCompatibleDaemon(manifest, {
        serverVersion: connection.serverVersion,
        waitsForOtherClients: connection.features.includes(SHUTDOWN_WHEN_IDLE_CLIENTS_FEATURE),
        listRuns: async () => (await connection.control.request('listRuns', {})).runs,
        cliWaits: () => connection.cliWaits(),
        otherDevices: () => otherDeviceCount(connection.devices()),
        shutdownWhenIdle: () => connection.control.request('shutdownWhenIdle', {}),
        shutdownNow: () => shutDownNow(connection, (line) => log(line)),
        handsOver: connection.features.includes(HAND_OVER_FEATURE),
        handOver: (when) => (when === 'now' ? handOverNow(connection, (line) => log(line)) : connection.control.request('handOver', { when })),
        ...(connection.features.includes(HAND_OVER_IF_IDLE_FEATURE) ? { handOverIfIdle: () => handOverIfIdle(connection, (line) => log(line)) } : {}),
      }, (line) => log(line));
      const { outcome } = adopted;
      const pendingBefore = adopted.outcome === 'switchWhenIdle' && this.followCompatible(authority, connection, adopted.runs, required);
      if (outcome !== 'switchWhenIdle') {
        this.settleSwitch(authority);
        const state = this.requireRemoteState();
        if (state.pendingSince(authority) !== undefined) void state.setPendingSince(authority, undefined).catch(this.report('Forgetting when the host\'s switch started waiting'));
      }
      if (outcome === 'useAsIs' && supersedes(manifest.version, connection.serverVersion)) this.olderInUse.add(connection);
      // a replaced daemon's connection is not the one the host settles on
      if (outcome !== 'replaceNow') {
        this.switchReminders.settled(authority, outcome === 'current');
        this.switchReminders.connected(authority, pendingBefore);
      } else {
        this.switchReminders.following(authority, connection.serverVersion);
      }
      return outcome === 'replaceNow' ? 'replaced' : 'kept';
    } catch (err) {
      this.settleSwitch(authority);
      this.report('Switching the host to this version')(err);
      return 'kept';
    }
  }

  // When the daemon of serverVersion must have switched (A11), or undefined when the manifest requires nothing of it: the first
  // detection is kept with its deadline, which a shorter grace only brings closer, and forgotten once nothing is required. A
  // deadline found passed gives the daemon the countdown's length once per run, which is never stored.
  private async requiredDeadlineOf(authority: string, manifest: ServerManifest, serverVersion: string): Promise<{ readonly deadline: number } | undefined> {
    const requirement = requiredOf(manifest, serverVersion);
    const state = this.requireRemoteState();
    const stored = state.requiredSince(authority);
    if (requirement === undefined) {
      this.missedDeadlines.delete(authority);
      if (stored !== undefined) await state.setRequiredSince(authority, undefined).catch(this.report('Forgetting the required update\'s deadline'));
      return undefined;
    }
    const { record, deadline } = requiredDeadline(stored, serverVersion, requirement.graceHours, Date.now());
    if (stored?.serverVersion !== record.serverVersion || stored.deadline !== record.deadline) {
      log(`[update] ${authority}: the daemon of ${serverVersion} must switch to ${requirement.minimumServerVersion} or later by ${new Date(record.deadline).toISOString()}`);
      await state.setRequiredSince(authority, record).catch(this.report('Keeping the required update\'s deadline'));
    }
    if (deadline === record.deadline) return { deadline };
    const missed = this.missedDeadlines.get(authority);
    if (missed?.serverVersion === serverVersion) return { deadline: missed.deadline };
    log(`[update] ${authority}: the deadline of the daemon of ${serverVersion} passed while this app was away; it switches at ${new Date(deadline).toISOString()}`);
    this.missedDeadlines.set(authority, { serverVersion, deadline });
    return { deadline };
  }

  // When the host's switch from the daemon of serverVersion started waiting, kept across relaunches until a connect finds none
  // pending; before: an earlier connection, of this run or one before, found it, so this fresh one reminds (P6).
  private pendingSinceOf(authority: string, serverVersion: string): { readonly since: number; readonly before: boolean } {
    const state = this.requireRemoteState();
    const stored = state.pendingSince(authority);
    if (stored?.serverVersion === serverVersion) return { since: stored.since, before: true };
    const since = Date.now();
    void state.setPendingSince(authority, { serverVersion, since }).catch(this.report('Keeping when the host\'s switch started waiting'));
    return { since, before: false };
  }

  // A compatible daemon asked to exit once idle: its pending switch shows on every surface until the next connect settles.
  private followCompatible(authority: string, connection: RemoteConnection, runs: readonly Run[], required: { readonly deadline: number } | undefined): boolean {
    log(`[update] ${authority}: waiting for the daemon of ${connection.serverVersion} to switch`);
    this.switchReminders.following(authority, connection.serverVersion);
    const pending = this.pendingSinceOf(authority, connection.serverVersion);
    this.pendingSwitches.follow(authority, (ended) => followCompatibleDaemon({
      connection,
      targetVersion: this.targetVersion(),
      runs,
      changed: () => this.pendingSwitchChanged(authority),
      ended,
      confirm: (listing) => this.confirmSwitchNow(authority, connection.serverVersion, listing),
      pollMs: SWITCH_POLL_MS,
      waitingSince: pending.since,
      ...(required !== undefined ? { required } : {}),
      ...(REMOTE_E2E.drainMs !== undefined ? { drainMs: REMOTE_E2E.drainMs } : {}),
      switched: (result) => this.switchReminders.switchSent(authority, result, this.targetVersion()),
      log: (line) => log(line),
    }));
    this.pendingSwitchChanged(authority);
    return pending.before;
  }

  // A reminder of the host's pending switch: Switch now asks as the strip's does, Show host opens the host card.
  private remindOfSwitch(authority: string, notice: NoticeText): void {
    const { t } = this.requireLocalization();
    const hostId = this.savedHostIdOf(authority);
    this.notificationCenter.hostUpdate(this.notificationHost(authority), notice.severity, notice.title, notice.message, [t('Switch now'), t('Show host')]).then(async (answer) => {
      if (hostId === undefined) return;
      if (answer === 0) await this.switchHostNow(hostId);
      else if (answer === 1) await this.requireRemoteHosts().openConnect(hostId, { card: 'show' });
    }).catch(this.shellFailure('Switch now', 'Damocles could not switch the host to this version: {0}'));
  }

  // The countdown to a required switch: sticky, shown whatever silences popups, with the taskbar button flashing.
  private countDownToSwitch(authority: string, notice: NoticeText, deadline: number): { withdraw(): void } {
    const { t } = this.requireLocalization();
    const hostId = this.savedHostIdOf(authority);
    const sticky = this.notificationCenter.stickyNotice(notice.severity, notice.message, [t('Switch now')], this.notificationHost(authority), { title: notice.title, countdownTo: deadline, timeSensitive: true });
    sticky.answer.then(async (answer) => {
      if (answer !== 0 || hostId === undefined) return;
      // a cancelled confirmation leaves the countdown running, so its notice comes back
      await this.switchHostNow(hostId).finally(() => this.switchReminders.countdownAnswered(authority));
    }).catch(this.shellFailure('Switch now', 'Damocles could not switch the host to this version: {0}'));
    return { withdraw: () => sticky.withdraw() };
  }

  private settleSwitch(authority: string): void {
    if (!this.pendingSwitches.has(authority)) return;
    this.pendingSwitches.forget(authority);
    this.pendingSwitchChanged(authority);
  }

  // Every surface of the host's pending switch follows it: the shell, the chat pages, the host card, Settings and its reminders.
  private pendingSwitchChanged(authority: string): void {
    const hostId = this.savedHostIdOf(authority);
    this.switchReminders.changed(authority, this.pendingSwitches.get(authority)?.update());
    if (hostId !== undefined) this.remoteHosts?.hostChanged(hostId);
    this.shellStateChanged();
    this.publishHostAttention();
    this.overlaySettings?.authorityChanged(authority);
  }

  // this app's version, which a switch moves a host to
  private targetVersion(): string {
    return appVersionOf(REMOTE_E2E.appVersion ?? this.requirePlatform().appInfo.version);
  }

  // A daemon of another protocol answered: newer than this app, it keeps running and the host shows that this app must update;
  // else it is stopped when it runs nothing, else the update offers the switch. Its chats show read-only from the mirror; once
  // it is gone this version connects.
  private followOtherProtocol(authority: string, daemon: OtherProtocolDaemon): void {
    const hostId = this.savedHostIdOf(authority);
    log(`[update] ${authority}: following the daemon of ${daemon.serverVersion} (protocol ${daemon.protocolVersion})`);
    this.switchReminders.following(authority, daemon.serverVersion);
    const pending = this.pendingSinceOf(authority, daemon.serverVersion);
    // its first update, which the flow publishes once it listed the runs, is what the connection found
    let connectTold = false;
    this.pendingSwitches.follow(authority, (ended) => followOtherProtocolDaemon({
      daemon,
      // the running chats read live from the mirror: saved chats it now holds open, and changed transcripts replay
      syncMirror: async () => {
        if (hostId === undefined) return;
        const projects = this.remoteProjects().filter((project) => project.authorityKey === authority).map((project) => project.folderKey);
        await this.sessionMirrorOf(hostId).schedule(() => projects);
        const records = this.requireRemoteState().chats(authority);
        const { opened, reloaded } = await this.transcripts.synced(authority, records, this.requireRemoteState().selected()?.sessionId);
        // the Chats list of a host not connected lists the mirror's chats, which this sync may have brought
        for (const project of this.remoteProjects()) if (project.authorityKey === authority) this.chatsChanged(project.key);
        log(`[update] ${authority}: mirror synced ${projects.length} projects; ${records.length} saved chats, ${opened} transcripts opened, ${reloaded} reloaded`);
      },
      changed: () => {
        this.pendingSwitchChanged(authority);
        if (connectTold || this.pendingSwitches.get(authority)?.update() === undefined) return;
        connectTold = true;
        this.switchReminders.connected(authority, pending.before);
      },
      // through the host's attempt, whose ssh its transport needs
      reconnect: () => this.connectAuthority(authority, false),
      ended,
      confirm: (listing) => this.confirmSwitchNow(authority, daemon.serverVersion, listing),
      targetVersion: this.targetVersion(),
      pollMs: SWITCH_POLL_MS,
      waitingSince: pending.since,
      required: hostId === undefined ? Promise.resolve(undefined) : this.serverInstall().then(({ manifest }) => this.requiredDeadlineOf(authority, manifest, daemon.serverVersion)),
      switched: (result) => this.switchReminders.switchSent(authority, result, this.targetVersion()),
      log: (line) => log(line),
    }));
    // the reconnect loop stops here: this flow connects once the old daemon is gone
    this.reconnector?.stateChanged(authority);
  }

  // No server runs on the host and its security floor is above this app, so its bridge started none: the host shows that this
  // app must update, until a connect settles or the host is forgotten.
  private belowFloor(authority: string, floor: string): void {
    const shown = this.pendingSwitches.get(authority)?.update();
    if (shown?.outdated === 'floor' && shown.serverVersion === floor) return;
    log(`[update] ${authority}: the host's security floor ${floor} is above this app of ${this.targetVersion()}; it starts no server there`);
    this.pendingSwitches.follow(authority, () => belowFloorSwitch(floor, this.targetVersion()));
    this.pendingSwitchChanged(authority);
    // the reconnect loop stops here: only updating this app changes the outcome
    this.reconnector?.stateChanged(authority);
  }

  // Switch now's confirmation (switchNowText).
  private async confirmSwitchNow(authority: string, serverVersion: string, listing: SwitchListing): Promise<boolean> {
    const { t } = this.requireLocalization();
    const { message, detail, preview } = switchNowText(listing, this.targetVersion(), { t, hostName: this.hostName(authority) });
    const answer = await this.ask({
      severity: 'danger',
      message,
      detail,
      actions: [t('Switch now')],
      cancelLabel: t('Cancel'),
      ...(preview.length > 0 ? { preview: preview.map((line) => visibleLines(line)) } : {}),
    });
    log(`[update] Switch now on ${authority} (daemon ${serverVersion}): ${answer === 0 ? 'confirmed' : 'cancelled'}`);
    return answer === 0;
  }

  private switchHostWhenIdle(hostId: string): Promise<void> {
    const pending = this.pendingSwitches.get(this.authorityOfHost(hostId));
    if (!pending) throw new Error('No switch is pending on the host');
    return pending.switchWhenIdle();
  }

  private switchHostNow(hostId: string): Promise<boolean> {
    const pending = this.pendingSwitches.get(this.authorityOfHost(hostId));
    if (!pending) throw new Error('No switch is pending on the host');
    return pending.switchNow();
  }

  // The update strip's and the host card's actions on a host; Check for updates is the app's own updater.
  private async hostUpdateAction(hostId: string, action: HostUpdateAction): Promise<void> {
    if (action === 'checkForUpdates') await runUpdateAction('check', this.aboutDeps());
    else if (action === 'switchWhenIdle') await this.switchHostWhenIdle(hostId);
    else await this.switchHostNow(hostId);
  }

  // the app's updater runs: off in the unpackaged app
  private canCheckForUpdates(): boolean {
    return this.updates !== undefined && this.updates.snapshot().state.kind !== 'disabled';
  }

  // The host card's notice while this connection's older daemon is used as it is for other computers, and no switch is pending.
  private serverInUse(authority: string): HostNotice | undefined {
    const connection = this.authorities?.connection(authority);
    return connection !== undefined && this.olderInUse.has(connection) && !this.pendingSwitches.has(authority) ? serverInUseNotice(connection) : undefined;
  }

  // The host's sub-call ledger and projects' session mirrors catch up, the most recently used project first: at each connect,
  // when a project joins the host, when one of its chats settles a turn and when the daemon reports a mirrored project or the
  // ledger changed (mirror.changed, mirror.subcallsChanged); requests that arrive while a sync runs coalesce into one more.
  private syncMirror(hostId: string, connection: RemoteConnection): void {
    const authority = this.authorityOfHost(hostId);
    const ordered = (): string[] => {
      const recent = this.hostStore?.host(hostId)?.recentFolders ?? [];
      const rank = (fsPath: string): number => {
        const at = recent.indexOf(fsPath);
        return at < 0 ? recent.length : at;
      };
      return this.remoteProjects().filter((project) => project.authorityKey === authority).sort((a, b) => rank(a.fsPath) - rank(b.fsPath)).map((project) => project.folderKey);
    };
    this.sessionMirrorOf(hostId).schedule(ordered).then(() => {
      if (this.authorities?.connection(authority) === connection) log(`[mirror ${hostId}] synced ${ordered().length} projects`);
    }, this.report('Syncing the session mirror'));
  }

  // A remote chat settled a turn or a project joined its host: the host's mirror syncs while its connection is up.
  private remoteSessionsChanged(authority: string): void {
    const hostId = this.savedHostIdOf(authority);
    const connection = this.authorities?.connection(authority);
    if (hostId !== undefined && connection) this.syncMirror(hostId, connection);
  }

  // The host's session mirror; its syncs run over the host's live connection.
  private sessionMirrorOf(hostId: string): SessionMirror {
    const authority = this.authorityOfHost(hostId);
    let mirror = this.sessionMirrors.get(hostId);
    if (!mirror) {
      mirror = new SessionMirror({
        root: path.join(this.userDataDir, 'remote', hostId, 'mirror'),
        channel: () => this.mirrorChannel(authority),
        log: (line) => log(`[mirror ${hostId}] ${line}`),
      });
      this.sessionMirrors.set(hostId, mirror);
    }
    return mirror;
  }

  // mirror.sync is frozen: a daemon of another protocol serves it as this version's does
  private mirrorChannel(authority: string): MirrorChannel {
    const connection = this.authorities?.connection(authority);
    if (connection) return connectionMirrorChannel(connection);
    const daemon = this.pendingSwitches.get(authority)?.following();
    if (!daemon) throw this.notConnected(authority);
    return frozenMirrorChannel(daemon);
  }

  private requireConnection(authorityKey: string): RemoteConnection {
    const connection = this.authorities?.connection(authorityKey);
    if (!connection) throw this.notConnected(authorityKey);
    return connection;
  }

  // Show log for a host: its transport's last stderr output, and its daemon's log through logs.read while connected, read-only.
  private async showHostLogs(hostId: string): Promise<void> {
    const authority = this.authorityOfHost(hostId);
    const record = this.requireHostStore().host(hostId);
    if (!record) throw new Error(`No host ${hostId}`);
    const { t } = this.requireLocalization();
    const output = transportOutputDocument(record, this.hostName(authority), this.requireRemoteConnections().stderrTail(hostId), t);
    this.requireEditorPane().openReadOnly(output.title, output.text, output.fileName, false);
    if (this.authorities?.connection(authority)) await this.showRemoteLog(authority, DAEMON_LOG, false);
  }

  // The label a remote chat page shows for its host, from this computer's host store; its banner says what the shell's would.
  private panelHostLabel(authority: string): PanelHostLabel {
    const color = this.hostColor(authority);
    const host = this.shellHostOf(authority);
    const attention = host === undefined ? undefined : hostAttention(host);
    const update = this.pendingSwitches.get(authority)?.update();
    const canAllowYolo = this.savedHostRecord(authority) !== undefined;
    const canCheckForUpdates = this.canCheckForUpdates();
    const removed = host?.removed;
    return { hostId: this.hostIdOf(authority), name: this.hostName(authority), ...(color !== undefined ? { color } : {}), computer: os.hostname(), ...(attention !== undefined ? { attention } : {}), ...(removed !== undefined ? { removed } : {}), ...(update !== undefined ? { update } : {}), ...(canCheckForUpdates ? { canCheckForUpdates } : {}), ...(canAllowYolo ? { canAllowYolo } : {}) };
  }

  private shellHostOf(authority: string): SavedShellHost | undefined {
    const hostId = this.savedHostIdOf(authority);
    return hostId === undefined ? undefined : this.remoteHosts?.shellHosts().find((candidate) => candidate.hostId === hostId);
  }

  // What the authority's saved host waits for the user to do, as the shell's and the chat pages' banners say it.
  private hostAttentionOf(authority: string): HostAttention | undefined {
    const host = this.shellHostOf(authority);
    return host === undefined ? undefined : hostAttention(host);
  }

  // Every saved host's name and color, which this computer's chat pages label remote /stats rows with; core never names a host.
  private panelHostNames(): PanelHostNames {
    const names: Record<string, { name: string; color?: HostColor }> = {};
    for (const host of this.hostStore?.hosts() ?? []) names[host.id] = { name: host.name, ...(host.color !== undefined ? { color: host.color } : {}) };
    if (LOOPBACK) names['loopback'] = { name: this.hostName('loopback') };
    return names;
  }

  private publishHostNames(): void {
    const names = this.panelHostNames();
    const sent = JSON.stringify(names);
    if (sent === this.sentHostNames) return;
    this.sentHostNames = sent;
    this.views?.broadcastHostNames(names);
  }

  // Every chat page of a host whose banner state changed hears it; the shell's banner follows the same ShellState publish.
  private publishHostAttention(): void {
    const views = this.views;
    if (!views || !this.remoteHosts) return;
    for (const host of this.remoteHosts.shellHosts()) {
      const attention = JSON.stringify([hostAttention(host) ?? null, host.removed ?? null, this.pendingSwitches.get(host.authorityKey)?.update() ?? null]);
      if (this.sentHostAttention.get(host.hostId) === attention) continue;
      this.sentHostAttention.set(host.hostId, attention);
      views.broadcastHost(host.authorityKey, this.panelHostLabel(host.authorityKey));
    }
  }

  // A remote chat page's banner: Reconnect or Sign in, on that page's own host.
  private panelHostAction(panel: DesktopPanel, action: PanelHostAction): void {
    const hostId = this.savedHostIdOf(panel.authority);
    if (hostId === undefined) {
      log(`[views] a chat of ${panel.authority} asked for ${action}, but no saved host serves it`);
      return;
    }
    if (action === 'signIn') {
      this.openConnect(hostId, { purpose: 'signIn' });
      return;
    }
    if (action === 'showLog') {
      this.requireRemoteHosts().showLog(hostId).catch(this.shellFailure('Show log', 'Damocles could not show the host\'s log: {0}'));
      return;
    }
    if (action === 'editHost') {
      this.requireRemoteHosts().openConnect(hostId, { card: 'rename' }).catch(this.shellFailure('Edit host', 'Damocles could not open the Connect dialog: {0}'));
      return;
    }
    if (action === 'switchWhenIdle') {
      this.switchHostWhenIdle(hostId).catch(this.shellFailure('Switch when they finish', 'Damocles could not switch the host to this version: {0}'));
      return;
    }
    if (action === 'switchNow') {
      this.switchHostNow(hostId).catch(this.shellFailure('Switch now', 'Damocles could not switch the host to this version: {0}'));
      return;
    }
    if (action === 'checkForUpdates') {
      this.hostUpdateAction(hostId, action).catch(this.shellFailure('Check for updates', 'Damocles could not check for updates: {0}'));
      return;
    }
    void reportFailure(async () => this.reconnectHost(hostId), this.shellFailure('Reconnect', 'Damocles could not reconnect to the host: {0}'))();
  }

  // One reconnect's offline saves that met a changed target: each opens its merge editor, and one summary names them all.
  private uploadsConflicted(authority: string, conflicted: readonly TextDocument[]): void {
    const editorPane = this.requireEditorPane();
    for (const document of conflicted) editorPane.showUploadMerge(document);
    this.reportReconnectConflicts(authority, conflicted.map((document) => ({ projectKey: document.location!.projectKey!, relativePath: document.location!.relativePath! })));
  }

  // After a rename or recolor every place that shows the host follows at once: the shell, its chat pages, its notifications.
  private hostRenamed(hostId: string, previousName: string): void {
    const authority = this.authorityOfHost(hostId);
    const label = this.panelHostLabel(authority);
    // the name a notification shows still is the previous one; it takes the new name and color
    this.notificationCenter.relabelHost(previousName, this.notificationHost(authority));
    this.views?.broadcastHost(authority, label);
    this.overlaySettings?.hostChanged(authority);
    for (const listener of [...this.hostNoticeListeners]) listener(hostId);
    this.remoteHosts?.hostsChanged();
    this.shellStateChanged();
  }

  // The reconnect loop's phase for an authority; undefined while it is connected or no loop runs for it.
  private reconnectPhaseOf(authority: string): HostReconnect | undefined {
    return this.reconnector?.phase(authority);
  }

  // A remote chat page's host as its banner and held messages need it: connected, away with the loop's phase, or offline.
  private chatConnectionState(authority: string): ChatConnection['state'] {
    if (this.authorities?.connection(authority)) return { phase: 'connected' };
    return this.reconnectPhaseOf(authority) ?? { phase: 'offline' };
  }

  private panelConnection(panel: DesktopPanel): PanelConnection | undefined {
    if (panel.kind !== 'chat' || panel.authority === 'local') return undefined;
    const token = panel.heldToken;
    return { state: this.chatConnectionState(panel.authority), queued: token === undefined ? [] : (this.offlineQueue?.queued(token) ?? []) };
  }

  // A live remote chat page's send while its host is away waits in main (docs/invariants.md "Desktop host", offline chat queue).
  private holdWhileAway(panel: DesktopPanel, message: unknown): boolean {
    const token = panel.heldToken;
    const queue = this.offlineQueue;
    if (!queue || panel.authority === 'local' || panel.offline || token === undefined || this.authorities?.connection(panel.authority)) return false;
    const outcome = queue.hold(panel.authority, token, message);
    if (outcome === 'held' || outcome === 'ignored') return outcome === 'held';
    // past the bounds the message goes back to the composer with why, as core gives back a send it refuses
    // the chat's page renders it in its own language
    const detail = outcome === 'tooMany'
      ? l('A chat holds at most {0} messages while {1} is away.', MAX_HELD_PER_PANEL, this.hostName(panel.authority))
      : outcome === 'tooLarge'
        ? l('Messages held while {0} is away can take at most {1} MB.', this.hostName(panel.authority), MAX_HELD_BYTES / (1024 * 1024))
        : l('Damocles can\'t hold messages while {0} is away, because it can\'t read {1}.', this.hostName(panel.authority), this.requireRemoteState().filePath);
    const content = parseContent((message as { content?: unknown }).content) ?? [];
    log(`[views] panel ${panel.panelId}: a held message was refused (${outcome})`);
    void panel.postMessage({ type: 'promptReturned', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, reason: 'heldPromptKept', detail } satisfies ExtensionToWebviewMessage);
    return true;
  }

  // A chip's Cancel (a waiting message) or Discard (a not-sent one), on the page's own held messages only.
  private heldMessageAction(panel: DesktopPanel, action: PanelQueueAction): void {
    const token = panel.heldToken;
    const removed = token !== undefined && this.offlineQueue?.remove(token, action.id, action.action === 'cancel' ? 'queued' : 'notSent') === true;
    if (!removed) log(`[views] panel ${panel.panelId}: no held message ${action.id} to ${action.action}`);
  }

  // Core's verdict on a flushed held message: a conversationChanged return stays in main as a not-sent chip.
  private takeHeldVerdict(panel: DesktopPanel, type: string, json: string): boolean {
    if (type !== 'promptReturned' && type !== 'userMessage' && type !== 'messageQueued') return false;
    const token = panel.heldToken;
    const queue = this.offlineQueue;
    if (token === undefined || !queue?.awaitsVerdict(token)) return false;
    return queue.fromCoreText(token, json);
  }

  // Every page showing the token's held messages hears them: the live chat's and a mirrored transcript's.
  private heldMessagesChanged(panelToken: string): void {
    for (const view of this.views?.chats() ?? []) {
      if (view.heldToken !== panelToken) continue;
      const connection = this.panelConnection(view);
      if (connection) view.sendConnection(connection);
      // a new chat's held messages are what keeps it, saved and loaded
      if (!view.offline) this.saveRemoteChats(view.authority);
    }
    this.scheduleRetention();
  }

  // Each remote chat page hears its host's phase when it changes; held messages follow heldMessagesChanged.
  private publishChatConnections(): void {
    const authorities = new Set((this.views?.chats() ?? []).flatMap((view) => (view.authority === 'local' ? [] : [view.authority])));
    for (const authority of authorities) {
      const text = JSON.stringify(this.chatConnectionState(authority));
      if (this.sentChatConnection.get(authority) === text) continue;
      this.sentChatConnection.set(authority, text);
      for (const view of this.remoteChatViews(authority)) {
        const connection = this.panelConnection(view);
        if (connection) view.sendConnection(connection);
      }
    }
  }

  // The host is back and its chats rejoined: each live page's held messages send in order through its own relay, once that
  // page's rejoin or restore settled.
  private flushHeldMessages(authority: string): void {
    const queue = this.offlineQueue;
    if (!queue) return;
    for (const token of queue.waiting(authority)) {
      const view = this.remoteChatViews(authority).find((candidate) => !candidate.offline && candidate.panelToken === token);
      if (!view) {
        log(`[remote] held messages of a chat that is not open on ${authority} wait for it`);
        continue;
      }
      (this.chatRestores.get(view) ?? Promise.resolve())
        // a round trip on the core channel: the activity core emitted during the drop (replayed after a resume) is in by its answer
        .then(() => this.chatHost(authority).run('Send the held chat messages', (core) => core.client.whenSetUp(view.panelId)))
        .then(() => {
          if (view.isDisposed || !this.authorities?.connection(authority)) return;
          const state = this.activityOf(view)?.state;
          queue.flush(token, state === 'running' || state === 'requires_action', (message) => view.deliver(message));
        })
        .catch(this.report('Sending the held chat messages'));
    }
  }

  // A new core epoch after a drop: the chats reopened with their permissions; the user hears which side restarted.
  private hostRestarted(authority: string, restarted: 'server' | 'engine'): void {
    const { t } = this.requireLocalization();
    const name = this.hostName(authority);
    const message = restarted === 'server' ? t('{0}\'s Damocles server restarted', name) : t('{0}\'s Damocles engine restarted', name);
    void this.notificationCenter.notice('info', message, [], this.notificationHost(authority));
  }

  /** A devcontainer Damocles did not create keeps its chats inside it; Rebuild Container opens the card's confirmation. */
  private notifyContainerWithoutDataVolume(hostId: string): void {
    const { t } = this.requireLocalization();
    const authorityKey = this.authorityOfHost(hostId);
    const title = t('Chats in {0} are lost when it is rebuilt', this.hostName(authorityKey));
    const message = t('Damocles did not create this container, so the chats and settings in it live inside it and a rebuild removes them. Rebuild it from Damocles once to keep them in its data volume from then on.');
    const rebuild = t('Rebuild Container...');
    this.notificationCenter.notice('warning', message, [rebuild], this.notificationHost(authorityKey), title).then(async (answer) => {
      // the host may be forgotten meanwhile
      if (answer === 0 && this.hostStore?.host(hostId)?.kind === 'container') await this.requireRemoteHosts().openConnect(hostId, { card: 'rebuild' });
    }).catch(this.report('Showing the container data notice'));
  }

  /** Other machines run Damocles in the host's home; Show host opens its card. */
  private notifySharedHome(authorityKey: string, hosts: readonly string[]): void {
    const { t, language } = this.requireLocalization();
    const list = (names: readonly string[]): string => new Intl.ListFormat(language, { type: 'conjunction' }).format(names);
    const title = hosts.length === 1 ? t('{0} also runs Damocles in this home', hosts[0]!) : t('{0} also run Damocles in this home', list(hosts));
    const message = t('Your home is shared, so chats and memories there are shared between {0}. Each machine keeps its own logs and server state.', list([this.hostName(authorityKey), ...hosts]));
    const show = t('Show host');
    this.notificationCenter.notice('warning', message, [show], this.notificationHost(authorityKey), title).then(async (answer) => {
      const hostId = this.savedHostIdOf(authorityKey);
      if (answer === 0 && hostId !== undefined) await this.requireRemoteHosts().openConnect(hostId, { card: 'show' });
    }).catch(this.report('Showing the machines sharing the home'));
  }

  /** Offline saves whose target changed meanwhile: one summary toast per upload pass; Review shows the first merge. */
  private reportReconnectConflicts(authority: string, files: ReadonlyArray<{ readonly projectKey: string; readonly relativePath: string }>): void {
    const first = files[0];
    if (!first) return;
    const { t } = this.requireLocalization();
    const name = this.hostName(authority);
    const fileName = this.hostPathFlavor(authority).basename(first.relativePath);
    const message = files.length === 1
      ? t('{0} changed on {1} while you were offline. Your save is kept in the merge editor.', fileName, name)
      : t('{0} files changed on {1} while you were offline. Your saves are kept in the merge editor.', files.length, name);
    const review = t('Review');
    this.notificationCenter.notice('warning', message, [review], this.notificationHost(authority)).then((answer) => {
      if (answer === 0) this.requireEditorPane().focusUploadMerge(first);
    }, this.report('Showing the offline save conflicts'));
  }

  // The status dot follows the state; a connection that came up reattaches its kept terminals. A connection that closed left
  // them reconnecting, so its next one reattaches them, and until then their records stay as saved; one the daemon holds for
  // a resume keeps them attached.
  private authorityChanged(authorityKey: string): void {
    const connection = this.authorities?.connection(authorityKey);
    const hostId = this.savedHostIdOf(authorityKey);
    if (hostId !== undefined) this.remoteHosts?.hostChanged(hostId);
    this.pendingSwitches.stateChanged(authorityKey, this.authorities?.state(authorityKey) ?? 'offline');
    if (this.authorities?.state(authorityKey) === 'connected' && connection) {
      for (const key of [...this.catalogRows.keys()]) if (authorityKeyOfProject(key) === authorityKey) this.catalogRows.delete(key);
      const reselect = this.transcripts.hostConnected(authorityKey);
      if (reselect !== undefined) this.reselectRemote.set(authorityKey, reselect);
      this.detectHostTerminals(authorityKey);
      // before the reattach's list, so no state change falls between the list and the events
      this.followResponding(authorityKey, connection);
      this.reattachRemoteTerminals(authorityKey);
      this.watchLimitsOf(authorityKey, connection);
      this.sharedHomes.ask(authorityKey, connection);
      this.connectRemoteCore(authorityKey);
    } else if (!this.authorities?.heldConnection(authorityKey)) {
      this.offlineQueue?.connectionEnded(authorityKey);
      this.reattachedAuthorities.delete(authorityKey);
      this.savedRemoteTerminals.delete(authorityKey);
      this.watchLimitConnections.get(authorityKey)?.subscription.dispose();
      this.watchLimitConnections.delete(authorityKey);
    }
    this.fileTree?.connectionsChanged();
    this.documents?.connectionsChanged();
    this.htmlPreviews?.connectionsChanged();
    this.devcontainerConfigs.refresh(this.remoteProjects().filter((project) => project.authorityKey === authorityKey).map((project) => project.key));
    this.remotePresences.check(this.checkedRemoteProjects(authorityKey)).catch(this.report('Checking the remote project folders'));
    this.refreshScmRoots();
    this.reconnector?.stateChanged(authorityKey);
    // after the loop took the state, so a drop it reconnects never reads as offline
    this.overlaySettings?.authorityChanged(authorityKey);
    this.shellStateChanged();
  }

  // Developer: Open Folder Through Local Daemon... (dev and e2e only): a local folder opened as a loopback project.
  private async openFolderThroughLocalDaemon(): Promise<void> {
    const platform = this.requirePlatform();
    const { t } = platform.localization;
    const folder = await platform.nativeDialogs.pickFolder({ title: t('Open Folder Through Local Daemon') });
    if (folder === undefined) return;
    await this.addLoopbackProject(folder);
  }

  private async addLoopbackProject(folder: string): Promise<void> {
    await this.requireAuthorities().connect('loopback');
    await this.addRemoteProject('loopback', folder);
  }

  // A folder of a connected authority joins the project list after the trust question and is selected; a folder that is a project
  // already is selected. A missing project of the host whose chats the folder may take over is offered first, as Add Project
  // offers a local one, and Move Chats runs Locate onto the folder (remote-project-add.ts). Resolves the project's key.
  private async addRemoteProject(authorityKey: string, folder: string): Promise<string> {
    this.requireConnection(authorityKey);
    const host = this.hostName(authorityKey);
    const folderKeyOf = (projectKey: string): string => {
      const key = targetFolderKeyOf(projectKey);
      if (key === undefined) throw new Error(`${projectKey} names no folder of ${authorityKey}`);
      return key;
    };
    return addRemoteProjectAt({
      opening: this.projectOpening(),
      askTrust: (projectKey, added) => this.requireRemoteTrust().ask({ key: projectKey, authorityKey, folderKey: folderKeyOf(projectKey), fsPath: added, host }),
      // the hold's mirror update reaches the host's core ahead of projects.movedFrom, on the same ordered channel
      holdTrust: (projectKey, added) => this.trustPending.hold(authorityKey, { folderKey: folderKeyOf(projectKey), fsPath: added }),
      missingProjectOf: (added) => this.remoteMissingProjectOf(authorityKey, added),
      moveChats: (key, added) => this.locateProject(key, added),
      joinQuit: (work) => this.quitJoins.join(work),
    }, authorityKey, folder);
  }

  // The host core's projects.movedFrom for the folder, among the host's listed projects, and the user's answer whether one's
  // chats move here; a daemon that does not move folders, or a failed lookup, offers none.
  private async remoteMissingProjectOf(authorityKey: string, folder: string): Promise<MissingProject | undefined> {
    const client = this.clientFor(authorityKey);
    if (!client?.relocates) return undefined;
    const candidates = await client.movedFrom(folder).catch((err: unknown) => {
      log(`[projects] looking for missing projects of ${folder} on ${authorityKey} failed: ${errorText(err)}`);
      return [];
    });
    const missing = candidates.flatMap((candidate): MissingProject[] => {
      const key = this.relocationKey(authorityKey, candidate.from);
      const project = this.remoteProject(key);
      return project ? [{ key, name: project.name, fsPath: project.fsPath, chats: candidate.chats }] : [];
    });
    if (missing.length === 0) return undefined;
    const { t } = this.requireLocalization();
    return askToMove(folder, missing, {
      confirm: (question) => this.askLocateConfirm(question),
      pick: (placeholder, items) => this.pickMissingProject(placeholder, items),
      t: (message, ...args) => t(message, ...args),
    });
  }

  // Show log for the loopback host: the end of its daemon.log through control logs.read, as inert read-only text.
  private async showLocalDaemonLog(): Promise<void> {
    await this.requireAuthorities().connect('loopback');
    await this.showRemoteLog('loopback', DAEMON_LOG, false);
  }

  // A log on a host (its daemon's, its core's, its Git log): the end of the file through control logs.read, as a read-only
  // editor tab named with the host; the text is never interpreted.
  private async showRemoteLog(authority: string, name: string, preserveFocus: boolean): Promise<void> {
    const { t } = this.requireLocalization();
    const control = this.authorities?.connection(authority)?.control;
    if (!control) throw this.notConnected(authority);
    const { logs } = await control.request('logs.list', {});
    const entry = logs.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(t('{0} has no log yet.', this.hostName(authority)));
    const length = Math.min(entry.size, MAX_LOG_READ_BYTES);
    const { bytes } = await control.request('logs.read', { name, offset: entry.size - length, length });
    this.requireEditorPane().openReadOnly(t('{0}: {1}', this.hostName(authority), name), Buffer.from(bytes).toString('utf8'), name, !preserveFocus);
  }

  private loopbackControl(): RemoteConnection['control'] {
    const control = this.authorities?.connection('loopback')?.control;
    if (!control) throw this.notConnected('loopback');
    return control;
  }

  private requireHostStore(): HostStore {
    if (!this.hostStore) throw new Error('The host store used before startup finished');
    return this.hostStore;
  }

  // The sidebar's project keys as shown now: projects.json's and remote-hosts.json's, in the stored order.
  private shellProjectKeys(): string[] {
    const listed = this.listedProjectKeys();
    return this.hostStore?.order(listed) ?? listed;
  }

  // The project keys shown now, local ones first, in no particular order.
  private listedProjectKeys(): string[] {
    return [...this.projects.folders().map((folder) => folderKey(folder.fsPath)), ...this.remoteProjects().map((project) => project.key)];
  }

  // The grouped view's groups shown now: this computer's, and each authority with a shown project.
  private shownGroups(): string[] {
    return groupsOf(this.shellProjectKeys());
  }

  // A folder joins the project list on its authority, right after a project when one is named (Files' Open as project).
  private projectOpening(): OpenAsProjectDeps {
    const { t } = this.requireLocalization();
    return {
      resolve: (key) => {
        const root = this.roots.resolve(key);
        return root && { ...root, os: this.projectOs(root.root.projectKey) };
      },
      served: (authorityKey) => authorityKey !== 'loopback' || LOOPBACK,
      isDirectory: (authorityKey, folder) => (authorityKey === 'local' ? this.requireWorkspaces().local : this.remoteWorkspace(authorityKey)).files.isDirectory(folder),
      projectKeyOf: async (authorityKey, folder) => {
        if (authorityKey === 'local') return folderKey(folder);
        const connection = this.requireConnection(authorityKey);
        // the daemon computes the folder's key by its own OS's rules
        const targetKey = await connection.workspace.request('files.folderKey', { path: folder });
        const authority = authorityKey === 'loopback' ? { kind: 'loopback' as const } : this.hostAuthority(authorityKey);
        if (!authority) throw new Error(`No saved host is named ${authorityKey}`);
        return projectKeyOf(authority, targetKey);
      },
      isProject: (key) => this.workspaceProjects().some((project) => project.key === key),
      add: async (authorityKey, folder, key, after) => {
        if (authorityKey === 'local') {
          // the order first, so the project shows in its place the moment projects.json lists it
          if (after !== undefined) await this.requireHostStore().placeAfter(key, after, () => this.listedProjectKeys());
          await this.projects.add(folder);
          return;
        }
        const targetKey = targetFolderKeyOf(key)!;
        const { os } = this.requireConnection(authorityKey).facts;
        await this.requireHostStore().addProject(authorityKey, { path: folder, folderKey: targetKey, os }, key, () => this.listedProjectKeys(), after);
      },
      added: (authorityKey) => {
        if (authorityKey !== 'local') this.remoteSessionsChanged(authorityKey);
      },
      requestTrust: async (key) => {
        const project = this.workspaceProjects().find((candidate) => candidate.key === key);
        if (project) await this.requestProjectTrust(project);
      },
      // opening a folder as a project is the user's
      select: (key) => this.selectProject(key, true),
      notFolder: (authorityKey, folder) => new Error(authorityKey === 'local' ? t('The folder {0} does not exist.', folder) : t('The folder {0} does not exist on {1}.', folder, this.hostName(authorityKey))),
    };
  }

  // Remote terminals into remote-state.json by authority, only for an authority whose kept terminals this window reattached,
  // so a change made before its daemon answers never drops the terminals it still runs.
  private persistRemoteTerminals(terminals: readonly RemoteTerminalRecord[]): void {
    const state = this.remoteState;
    if (!state) return;
    for (const authorityKey of this.reattachedAuthorities) {
      const records = terminals.filter((terminal) => authorityKeyOfProject(terminal.projectKey) === authorityKey);
      const text = JSON.stringify(records);
      if (this.savedRemoteTerminals.get(authorityKey) === text) continue;
      this.savedRemoteTerminals.set(authorityKey, text);
      state.setTerminals(authorityKey, records).catch(this.report('Saving the remote terminals'));
    }
  }

  // A connected authority's kept terminals, which outlive the app, get their tabs back once the window restored its own.
  private reattachRemoteTerminals(authorityKey: string): void {
    const { terminals, remoteState, shell } = this;
    const workspace = this.authorities?.connectedWorkspace(authorityKey);
    if (!terminals || !remoteState || !shell || !workspace || this.reattachedAuthorities.has(authorityKey)) return;
    Promise.all([this.terminalsRestored, this.hostTerminalsDetected(authorityKey)]).then(async () => {
      if (this.shell !== shell || this.reattachedAuthorities.has(authorityKey) || this.authorities?.connectedWorkspace(authorityKey) !== workspace) return;
      this.reattachedAuthorities.add(authorityKey);
      const killed = await terminals.reattach(workspace.terminals, authorityKey, remoteState.terminals(authorityKey), remoteState.pendingKills(authorityKey));
      if (killed.length > 0) await remoteState.killsDone(authorityKey, killed);
    }).catch(this.report('Reattaching the remote terminals'));
  }

  // A host's terminal another client may have started, in this window's terminal panel once the window's own terminals and
  // the host's shells are back.
  private async openHostTerminal(authorityKey: string, id: string): Promise<void> {
    const workspace = this.authorities?.connectedWorkspace(authorityKey);
    if (!workspace) throw new Error(`${this.hostName(authorityKey)} is not connected`);
    await Promise.all([this.terminalsRestored, this.hostTerminalsDetected(authorityKey)]);
    if (this.authorities?.connectedWorkspace(authorityKey) !== workspace) throw new Error(`${this.hostName(authorityKey)} is not connected`);
    await this.requireTerminals().open(workspace.terminals, authorityKey, id);
    this.showTerminalPane();
  }

  // A connection's terminals.responding events, heard once per connection: its terminals' tabs and the open host card follow.
  private followResponding(authorityKey: string, connection: RemoteConnection): void {
    const workspace = this.authorities?.connectedWorkspace(authorityKey);
    if (!workspace || this.respondingWatched.has(connection)) return;
    this.respondingWatched.add(connection);
    connection.workspace.onEvent('terminals.responding', (event) => {
      this.terminals?.responding(workspace.terminals, event);
      const hostId = this.savedHostIdOf(authorityKey);
      if (hostId !== undefined) this.remoteHosts?.hostChanged(hostId);
    });
  }

  // A connection's watch limit reports, heard once per connection.
  private watchLimitsOf(authorityKey: string, connection: RemoteConnection): void {
    const heard = this.watchLimitConnections.get(authorityKey);
    if (heard?.connection === connection) return;
    heard?.subscription.dispose();
    this.watchLimitConnections.set(authorityKey, { connection, subscription: this.watchLimits.watch(authorityKey, connection) });
  }

  // The shells and Windows build of a connected host, asked once per connection.
  private detectHostTerminals(authorityKey: string): void {
    const workspace = this.authorities?.connectedWorkspace(authorityKey);
    const kept = this.hostTerminals.get(authorityKey);
    if (!workspace || kept?.workspace === workspace) return;
    const host: HostTerminals = { workspace, profiles: kept?.profiles ?? [], windowsBuild: kept?.windowsBuild ?? null, detected: Promise.resolve(), ready: false };
    host.detected = Promise.all([workspace.terminals.detectProfiles(), workspace.terminals.windowsBuild()]).then(([profiles, windowsBuild]) => {
      host.profiles = profiles.map(detectedProfile);
      host.windowsBuild = windowsBuild;
      log(`[terminal] ${authorityKey}'s shells: ${profiles.map((profile) => profile.id).join(', ') || 'none'}`);
      this.terminals?.publish();
    }, (err: unknown) => log(`[terminal] detecting ${authorityKey}'s shells failed: ${errorText(err)}`)).finally(() => {
      host.ready = true;
    });
    this.hostTerminals.set(authorityKey, host);
  }

  // A remote root key's host terminals; undefined for this computer's.
  private hostTerminalsOf(projectKey: string | null): HostTerminals | undefined {
    const authority = projectKey === null ? 'local' : authorityKeyOfProject(projectKey);
    return authority === 'local' ? undefined : (this.hostTerminals.get(authority) ?? { workspace: undefined, profiles: [], windowsBuild: null, detected: Promise.resolve(), ready: true });
  }

  // Settles once an authority's shells and Windows build are known; at once for this computer's.
  private hostTerminalsDetected(authorityKey: string): Promise<void> {
    return this.hostTerminals.get(authorityKey)?.detected ?? Promise.resolve();
  }

  // Reopen in WSL and the open-folder-in-distro step it shares with `damocles .` in WSL.
  private reopenDeps(): ReopenDeps {
    this.requireRemoteHosts();
    return {
      localProject: (key) => {
        const folder = this.projects.folders().find((candidate) => folderKey(candidate.fsPath) === key);
        return folder && { fsPath: folder.fsPath, trusted: this.trust.isTrusted(folder.fsPath) };
      },
      wslpath: (distro, folder) => wslpathInDistro(distro, folder),
      ...this.openInDistroDeps(),
    };
  }

  private openInDistroDeps(): OpenInDistroDeps {
    return {
      distroHost: async (distro) => {
        const record = await this.requireRemoteHosts().distroHost(distro);
        return record && { hostId: record.id, authorityKey: this.authorityOfHost(record.id) };
      },
      connect: async (hostId) => {
        const connections = this.requireRemoteConnections();
        const outcome = connections.outcome(connections.connect(hostId, false, { user: true }));
        if (!outcome) throw new Error(`The attempt to reach ${hostId} was replaced`);
        await outcome;
      },
      open: async (authorityKey, folder, trusted) => {
        const opening = this.projectOpening();
        const { projectKey } = await openFolderAsProject({
          ...opening,
          // both entries name the same folder, so the local project's grant stands for the new one
          requestTrust: async (key) => {
            const targetKey = targetFolderKeyOf(key);
            if (trusted && targetKey !== undefined) await this.requireHostStore().grantTrust(authorityKey, targetKey);
            else await opening.requestTrust(key);
          },
        }, authorityKey, folder);
        return projectKey;
      },
      failureCode: (err) => failureOf(err).code,
      log: (line) => log(line),
    };
  }

  // A host's Allow YOLO turns on only from the user's answer to main's own question, never from a renderer's word alone.
  private readonly allowHostYolo = allowYoloAsker({
    savedHost: (authority) => {
      const record = this.savedHostRecord(authority);
      return record && { hostId: record.id, name: record.name, ...(record.color !== undefined ? { color: record.color } : {}), allowBypass: record.settings.allowBypass === true };
    },
    request: (request, signal) => {
      const overlay = this.overlay;
      if (!overlay) throw new Error('The window is not open');
      return overlay.request(request, webContents.getFocusedWebContents() ?? undefined, undefined, undefined, signal);
    },
    allow: (hostId) => this.requireRemoteHosts().setSetting(hostId, { key: 'allowBypass', value: true }),
    failed: (hostName, err) => {
      log(`[remote] allowing YOLO on ${hostName} failed: ${errorText(err)}`);
      void this.notifications.error(this.requireLocalization().t('Damocles could not allow YOLO on {0}: {1}', hostName, errorMessage(err)));
    },
  });

  // The saved host an authority key names: ssh+<id>'s id, or a recorded distro's for wsl+<distro>; undefined for any other.
  private savedHostIdOf(authorityKey: string): string | undefined {
    return this.hostStore ? this.hostStore.hostIdOf(authorityKey) : hostIdOfAuthority(authorityKey);
  }

  // The authorities this computer still holds (a saved host's, or one with listed projects): the local core drops the account
  // bindings and host defaults of every other.
  private keepForgeHosts(client: CoreClient): Promise<void> {
    return keepKnownHosts(this.hostStore, client, (line) => log(line));
  }

  // The saved host record an authority key names; undefined for a key no saved host holds (loopback included).
  // an SSH, WSL or container host's authority that no saved host holds: Forget host dropped it
  private forgottenHostAuthority(authorityKey: string): boolean {
    return /^(?:ssh|wsl|container)\+/.test(authorityKey) && this.savedHostRecord(authorityKey) === undefined;
  }

  private hostBeingForgotten(authorityKey: string): boolean {
    const hostId = this.savedHostIdOf(authorityKey);
    return hostId !== undefined && this.remoteConnections?.isForgotten(hostId) === true;
  }

  private savedHostRecord(authorityKey: string): HostRecord | undefined {
    const hostId = this.savedHostIdOf(authorityKey);
    return hostId === undefined ? undefined : this.hostStore?.host(hostId);
  }

  // A saved host's authority: an SSH host by its id, a WSL distro by its name; undefined for a key no saved host holds.
  private hostAuthority(authorityKey: string): Authority | undefined {
    const hostId = this.savedHostIdOf(authorityKey);
    const record = hostId === undefined ? undefined : this.hostStore?.host(hostId);
    if (!record) return undefined;
    if (record.kind === 'container') return { kind: 'container', key: record.key, ...(record.via !== undefined ? { via: record.via } : {}) };
    return record.kind === 'wsl' ? { kind: 'wsl', distro: record.distro } : { kind: 'ssh', hostId: record.id };
  }

  // Where a container record's engine and CLI run: this computer, or its SSH host's daemon.
  private containerSide(via: string | undefined, install: () => Promise<ServerInstall>): ContainerSide {
    if (via === undefined) {
      return localContainerSide({
        launcher: processLauncher,
        env: process.env,
        execPath: process.execPath,
        cliPath: devcontainersCliPath(createDesktopAppPaths(layout)),
        artifacts: async () => (await install()).artifacts,
      });
    }
    return viaContainerSide({
      hostId: via,
      hostName: () => this.hostName(this.authorityOfHost(via)),
      connection: () => this.authorities?.connection(this.authorityOfHost(via)),
      manifest: async () => {
        const { manifest, releasesUrl } = await install();
        return { manifest, ...(releasesUrl !== undefined ? { releasesUrl } : {}) };
      },
    });
  }

  private containerRecord(hostId: string): ContainerHostRecord {
    const record = this.requireHostStore().host(hostId);
    if (record?.kind !== 'container') throw new Error(`The host ${hostId} is no container`);
    return record;
  }

  // The devcontainer's trust gate: folder trust where the CLI runs, read-configuration, then the confirmation unless the
  // confirmed hash is unchanged (devcontainer-trust.ts). signal: the attempt's; mayAsk: a user watches it.
  private containerTrustGate(hostId: string, install: () => Promise<ServerInstall>, signal: AbortSignal, mayAsk: () => boolean): Promise<DevcontainerTrustVerdict> {
    const record = this.containerRecord(hostId);
    const { workspaceFolder, configPath, via } = record;
    if (record.origin !== 'devcontainer' || workspaceFolder === undefined || configPath === undefined) throw new Error(`The host ${hostId} is no devcontainer`);
    const side = this.containerSide(via, install);
    const store = this.requireHostStore();
    return runDevcontainerTrustGate({
      signal,
      mayAsk,
      requestFolderTrust: () => this.requestContainerFolderTrust(via, workspaceFolder),
      readConfiguration: (readSignal) => devcontainerReadConfiguration(side, { engine: record.engine, workspaceFolder, configPath }, (line) => log(`[container ${hostId}] ${line}`), readSignal),
      storedHash: () => this.containerRecord(hostId).trustHash,
      confirm: async (items, { changed }, confirmSignal) => {
        const viaHost = via === undefined ? undefined : store.host(via);
        const request = parseDevcontainerTrustRequest({ ...(viaHost ? { hostName: viaHost.name, ...(viaHost.color !== undefined ? { hostColor: viaHost.color } : {}) } : {}), folder: workspaceFolder, configPath, changed, items });
        const overlay = this.overlay;
        if (!request || !overlay) {
          log(`[container ${hostId}] the configuration confirmation cannot show (${request ? 'no overlay' : 'past its bounds'}); nothing runs`);
          return false;
        }
        this.revealWindow();
        return devcontainerTrustAccepted(await overlay.request(request, webContents.getFocusedWebContents() ?? undefined, undefined, undefined, confirmSignal));
      },
      storeHash: (hash) => store.setContainerTrustHash(hostId, hash),
    });
  }

  // Folder trust of a devcontainer's folder on the machine its CLI runs on, asking when it is not trusted.
  private async requestContainerFolderTrust(via: string | undefined, folder: string): Promise<boolean> {
    if (via === undefined) return this.trust.requestTrust(folder);
    const authorityKey = this.authorityOfHost(via);
    const folderKeyOnHost = await this.requireConnection(authorityKey).workspace.request('files.folderKey', { path: folder });
    return this.requireRemoteTrust().request({ key: projectKeyOf({ kind: 'ssh', hostId: via }, folderKeyOnHost), authorityKey, folderKey: folderKeyOnHost, fsPath: folder, host: this.hostName(authorityKey) });
  }

  // Whether a devcontainer's folder is trusted where its CLI runs, without asking.
  private async containerFolderTrusted(via: string | undefined, folder: string): Promise<boolean> {
    if (via === undefined) return this.trust.isTrusted(folder);
    const authorityKey = this.authorityOfHost(via);
    const connection = this.authorities?.connection(authorityKey);
    if (!connection) return false;
    return this.requireHostStore().isTrusted(authorityKey, await connection.workspace.request('files.folderKey', { path: folder }));
  }

  // A devcontainer's workspace folder in the container as its project, selected; its trust follows the bind-mounted folder's
  // where the CLI runs, which the gate required.
  private async openContainerFolder(hostId: string): Promise<string> {
    const record = this.containerRecord(hostId);
    if (record.origin !== 'devcontainer' || record.remoteWorkspaceFolder === undefined || record.workspaceFolder === undefined) throw new Error(`The container ${hostId} names no workspace folder`);
    const authorityKey = this.authorityOfHost(hostId);
    const trusted = await this.containerFolderTrusted(record.via, record.workspaceFolder);
    const opening = this.projectOpening();
    const { projectKey } = await openFolderAsProject({
      ...opening,
      requestTrust: async (key) => {
        const targetKey = targetFolderKeyOf(key);
        if (trusted && targetKey !== undefined) await this.requireHostStore().grantTrust(authorityKey, targetKey);
        else await opening.requestTrust(key);
      },
    }, authorityKey, record.remoteWorkspaceFolder);
    await this.requireHostStore().touchHost(hostId, record.remoteWorkspaceFolder);
    return projectKey;
  }

  // The projects whose devcontainer configuration ShellProject publishes: local ones outside WSL, whose read would start the
  // distro, and SSH ones.
  private devcontainerProjectKeys(): string[] {
    const local = this.projects.folders().filter((folder) => process.platform !== 'win32' || !wslUncToLinux(folder.fsPath)).map((folder) => folderKey(folder.fsPath));
    return [...local, ...this.remoteProjects().filter((project) => hostIdOfAuthority(project.authorityKey) !== undefined).map((project) => project.key)];
  }

  // The devcontainer configuration of a local or SSH project; null for none, or a project of another authority.
  private async devcontainerConfig(projectKey: string): Promise<string | null> {
    const local = this.projects.folders().find((folder) => folderKey(folder.fsPath) === projectKey);
    if (local) return this.containerSide(undefined, this.serverInstall).config(local.fsPath);
    const remote = this.remoteProject(projectKey);
    const via = remote && hostIdOfAuthority(remote.authorityKey);
    if (!remote || via === undefined || !this.authorities?.connection(remote.authorityKey)) return null;
    if (!this.authorities.connection(remote.authorityKey)?.features.includes('containers')) return null;
    return this.containerSide(via, this.serverInstall).config(remote.fsPath);
  }

  // Reopen in Container: the folder's devcontainer record, its attempt shown in the Connect dialog, and once connected its
  // workspace folder as the project. The local or SSH project and its chats stay.
  private async reopenInContainer(projectKey: string): Promise<ReopenInContainerResult> {
    const hosts = this.requireRemoteHosts();
    const local = this.projects.folders().find((folder) => folderKey(folder.fsPath) === projectKey);
    const remote = local ? undefined : this.remoteProject(projectKey);
    const via = remote && hostIdOfAuthority(remote.authorityKey);
    const folder = local?.fsPath ?? (via !== undefined ? remote?.fsPath : undefined);
    if (folder === undefined) return { ok: false, code: 'notLocalOrSsh' };
    if ((await this.devcontainerConfig(projectKey)) === null) return { ok: false, code: 'noDevcontainerConfig' };
    const made = await hosts.devcontainerHost(folder, via);
    if (!made.ok) throw new Error(containerNameRefusedText(made.check, this.requireLocalization().t));
    // the dialog starts the attempt once it shows, so the questions its trust gate asks stack above it
    return hosts.reopenInContainer(made.host.id);
  }

  // The authority key of a saved host's projects: ssh+<id>, or wsl+<distro> for a distro.
  private authorityOfHost(hostId: string): string {
    const authority = this.hostStore?.authorityOf(hostId);
    if (authority === undefined) throw new Error(`No saved host ${hostId}`);
    return authority;
  }

  // The authority of a host whose ports main forwards: a saved host's, or the loopback daemon's, which has no record.
  private portsHostAuthority(hostId: string): string {
    return hostId === LOOPBACK_HOST ? LOOPBACK_HOST : this.authorityOfHost(hostId);
  }

  // The id this install gives the host (its secrets namespace remote/<hostId>/); the loopback authority has no host record.
  private hostIdOf(authorityKey: string): string {
    if (authorityKey === 'loopback') return 'loopback';
    const hostId = this.savedHostIdOf(authorityKey);
    if (hostId !== undefined && this.hostStore?.host(hostId)) return hostId;
    throw new Error(`No host is named ${authorityKey}`);
  }

  // The error and browser pages' text, in the app's language.
  private pageStrings(): PageStrings {
    const { t } = this.requireLocalization();
    return {
      error: { title: t(ERROR_PAGE_STRINGS.title), detail: t(ERROR_PAGE_STRINGS.detail) },
      browser: {
        back: t('Back'),
        forward: t('Forward'),
        reload: t('Reload'),
        pickElement: t('Pick Element'),
        devTools: t('Open Developer Tools (F12)'),
        newTab: t('New Tab'),
        urlPlaceholder: t('Enter URL...'),
        notSecure: t('Not secure'),
        notSecureDetail: t('The connection to this site is not encrypted, so others on the network can read and change what it sends.'),
        waiting: t('Waiting for browser frames...'),
      },
    };
  }

  // The host's name as this computer names it; a target never names itself.
  private hostName(authorityKey: string): string {
    const { t } = this.requireLocalization();
    if (authorityKey === 'loopback') return t('Local daemon');
    const hostId = this.savedHostIdOf(authorityKey);
    const record = hostId === undefined ? undefined : this.hostStore?.host(hostId);
    if (record) return record.name;
    throw new Error(`No host is named ${authorityKey}`);
  }

  // A remote host as notifications show it: this computer's name and safety color for it.
  private notificationHost(authorityKey: string): NotificationHost {
    const color = this.hostColor(authorityKey);
    return { name: this.hostName(authorityKey), ...(color !== undefined ? { color } : {}) };
  }

  // The host's safety color as this computer keeps it.
  private hostColor(authorityKey: string): HostColor | undefined {
    const hostId = this.savedHostIdOf(authorityKey);
    return hostId === undefined ? undefined : this.hostStore?.host(hostId)?.color;
  }

  private remoteTrustTarget(project: RemoteProject): RemoteTrustTarget {
    return { key: project.key, authorityKey: project.authorityKey, folderKey: project.folderKey, fsPath: project.fsPath, host: this.hostName(project.authorityKey) };
  }

  private isProjectTrusted(project: Project): boolean {
    return this.requireProjectTrust().isTrusted(project);
  }

  private requestProjectTrust(project: Project): Promise<boolean> {
    return this.requireProjectTrust().request(project);
  }

  private requireProjectTrust(): ReturnType<typeof createProjectTrust> {
    if (!this.projectTrust) throw new Error('Project trust used before startup finished');
    return this.projectTrust;
  }

  private requireRemoteTrust(): ReturnType<typeof createRemoteTrust> {
    if (!this.remoteTrust) throw new Error('Remote trust used before startup finished');
    return this.remoteTrust;
  }

  // Files' view of a project's target: its OS, and the host's name for a remote one.
  private filesTarget(projectKey: string): FilesTarget {
    const remote = this.remoteProject(parseRootKey(projectKey)?.projectKey ?? projectKey);
    const authority = remote && this.hostAuthority(remote.authorityKey);
    return remote ? { os: remote.os, host: this.hostName(remote.authorityKey), ...(authority?.kind === 'wsl' ? { wslDistro: authority.distro } : {}) } : { os: process.platform };
  }

  // Trust's view of core's worktree records, and the controller whose UI core's worktree services reach; once per app run.
  private startWorktrees(): WorktreeController {
    const records = this.worktreeRecords;
    const trustWorktrees = this.trust.setWorktrees({
      projectOf: (folder) => records.liveChatRecordAt(folder)?.projectPath,
      liveWorkingFolders: () => liveWorkingFolders(records.records()),
      onDidChange: (listener) => records.onDidChange(listener),
    });
    const t = (message: string, ...args: Array<string | number>): string => this.requireLocalization().t(message, ...args);
    const report = (line: string): void => log(line);
    const askDialog = createWorktreeDialogAsker({
      overlay: () => this.overlay,
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      ask: this.ask,
      warn: (message) => void this.notifications.warn(message),
      t,
      log: report,
    });
    this.askWorktreeDialog = askDialog;
    const controller = new WorktreeController(this.worktreeControllerDeps('local', records, askDialog));
    this.worktrees = controller;
    this.disposables.push(records, trustWorktrees, records.onDidChange(() => this.worktreesChanged()));
    return controller;
  }

  // A worktree controller's services for the core of authority: this computer's, or a remote host's, whose worktrees, git,
  // finish holds and Setup terminal (on its pty host, through its workspace) are all that host's.
  private worktreeControllerDeps(authority: string, records: WorktreeRecords, askDialog: AskWorktreeDialog): WorktreeControllerDeps {
    const local = authority === 'local';
    const t = (message: string, ...args: Array<string | number>): string => this.requireLocalization().t(message, ...args);
    const report = (line: string): void => log(line);
    const run = <T>(label: string, work: (client: CoreClient, core: ChatCore) => Promise<T>): Promise<T> => this.chatHost(authority).run(label, (core) => work(core.client, core));
    const keyOf = (projectPath: string): string => this.worktreeProjectKey(authority, projectPath);
    return {
      authority,
      projectKeyOf: keyOf,
      records,
      engine: local ? this.worktreeEngine : worktreeEngine((method, args) => run(`Worktree ${method}`, (client) => client.worktreeCall(method, args))),
      roots: this.roots,
      // a remote host's own core answers whether it has git (the options' notGit)
      gitFound: local ? this.gitProbe.available : true,
      branchPrefix: () => this.requirePlatform().settings.get<string>(SCM_SETTING_KEYS.branchPrefix, '') ?? '',
      isTrusted: (folder) => (local ? this.trust.isTrusted(folder) : this.remoteFolderTrusted(authority, folder)),
      askDialog,
      ask: this.ask,
      notify: local ? this.notifications : this.hostNotices(authority),
      t,
      render: (text) => this.requireLocalization().render(text),
      log: report,
      setupShell: () => (local
        ? setupShell(process.platform, process.env, this.terminalProfiles?.profiles().find((profile) => profile.id === 'pwsh')?.file)
        : remoteSetupShell(this.remoteProjects().find((project) => project.authorityKey === authority)?.os)),
      runTask: (request) => {
        this.showTerminalPane();
        this.requireTerminals().runTask(request);
      },
      retrySetup: (worktreeId) => run('Retry Setup', (client) => client.retrySetup(worktreeId)),
      worktreeEnv: (record) => worktreeEnvironment(record),
      chatsUsing: (worktreeId) => [...this.worktreeStates.values()].filter((event) => event.worktreeId === worktreeId).map((event) => ({ panelId: event.panelId, busy: event.busy })),
      sessionsUsing: (worktreeId) => this.sessionsUsing(authority, worktreeId),
      leasedElsewhere: (sessionId) => run('Lease Check', (client) => client.leaseRefused(sessionId, false)),
      closeWorktree: (worktreeId, key, stop) => this.closeWorktreeRoot(authority, worktreeId, key, stop),
      afterClose: (worktreeId, removed) => this.worktreeClosed(authority, worktreeId, removed),
      showProjectFolder: (projectKey) => {
        this.shownFolders.show(projectKey, 'project');
      },
      // the hold is that core's: a restart before the action answers fails it with the engine-stopped notice
      beginFinish: (worktreeId, action) => run(`Worktree ${action}`, (client, core) => client.beginWorktreeFinish(worktreeId, action, () => !core.isReady())),
      showTask: (key) => {
        const terminals = this.requireTerminals();
        const id = terminals.taskTerminal(key);
        if (id === undefined) return false;
        this.showTerminalPane();
        terminals.select(id);
        return true;
      },
      stopTask: (key) => {
        const terminals = this.terminals;
        const id = terminals?.taskTerminal(key);
        if (terminals && id !== undefined) terminals.kill(id);
      },
      projectRepositoryWhenReady: async (projectPath) => this.scm?.projectRepositoryWhenReady(keyOf(projectPath)),
      worktreeChats: (projectPath) => this.worktreeChats(keyOf(projectPath)),
      openConflicts: (folder, files, applyBranch) => this.openWorktreeConflicts(authority, folder, files, applyBranch),
      publish: (key) => this.withScmRoot(key, async (repoId) => {
        await this.requireScm().runRequest({ op: 'publish', repoId });
      }),
      targetFacts: (record) => this.scm?.rootRepository(keyOf(record.projectPath)) ?? { hasRemote: false, detached: false },
      generateMessage: (record) => this.withScmRoot(this.worktreeRootKey(record, authority), async (repoId) => {
        const generated = await this.requireScm().generateMessage({ repoId });
        return generated.ok ? generated.message : undefined;
      }),
      changed: () => this.worktreesChanged(),
      reveal: (absolutePath) => (local ? this.requirePlatform().shell.revealPath(absolutePath) : Promise.reject(new Error(`${absolutePath} is not on this computer`))),
    };
  }

  // What source control's worktree flows need of worktree chats (D58, B40, B45, rules 14 and 16).
  private scmWorktreeDeps(): ScmWorktreeDeps {
    // a worktree path is native to its authority, so it is looked up only in that authority's registry, by its OS's rules
    const liveChatAt = (authority: string, worktreePath: string): ChatWorktreeRecord | undefined => {
      const os = this.authorityOs(authority);
      return this.worktreeRegistry(authority)?.records().find(
        (record): record is ChatWorktreeRecord => record.kind === 'chat' && record.deletedAt === undefined && folderKeyOn(os, record.worktreeRoot) === folderKeyOn(os, worktreePath),
      );
    };
    return {
      deleteChatWorktreeAt: async (authority, worktreePath) => {
        const record = liveChatAt(authority, worktreePath);
        if (!record) return false;
        await this.worktreesOf(authority).finish(record.id, 'delete');
        return true;
      },
      adopt: async (project, worktree, repositoryRoot, mainProject) => {
        await this.worktreeEngine.upsertAdopted({
          worktreeRoot: worktree.path,
          workingFolder: project.fsPath,
          repositoryRoot,
          ...(mainProject ? { projectPath: mainProject.fsPath } : {}),
          ...(worktree.branch !== null ? { branch: worktree.branch } : {}),
        });
      },
      adoptCreated: async (projectKey, repositoryRoot, worktreePath, branch) => {
        const project = this.desktopProjects().find((candidate) => candidate.key === projectKey);
        await this.worktreeEngine.upsertAdopted({ worktreeRoot: worktreePath, workingFolder: worktreePath, repositoryRoot, ...(project ? { projectPath: project.fsPath } : {}), ...(branch !== undefined ? { branch } : {}) });
      },
      markRemoved: (worktreePath) => this.worktreeEngine.markAdoptedRemoved(worktreePath),
      closeProject: (projectKey) => this.closeProjectForDelete(projectKey),
      chatOf: async (authority, worktreePath) => {
        const record = liveChatAt(authority, worktreePath);
        return record ? this.worktreeChatOf(record, authority) : undefined;
      },
      newChatTargetAt: (authority, worktreePath) => this.newChatInTarget(liveChatAt(authority, worktreePath)),
      selectChat: async (chatId) => {
        await this.selectChat(chatId);
      },
      showProjectFolder: (projectKey) => {
        this.shownFolders.show(projectKey, 'project');
      },
      projectCopyOf: (key, absolutePath) => {
        const root = this.roots.resolve(key);
        if (!root?.worktree) return undefined;
        const relative = path.relative(root.fsPath, absolutePath);
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
        const project = this.roots.resolve(root.root.projectKey);
        return project ? { project, relativePath: relative.split(path.sep).join('/') } : undefined;
      },
    };
  }

  // B45: the worktree's most recently viewed chat, loaded or listed; a worktree no chat uses yet names none.
  private async worktreeChatOf(record: ChatWorktreeRecord, authority: string): Promise<ScmWorktreeChat | undefined> {
    const loaded = [...this.worktreeStates.values()]
      .filter((event) => event.worktreeId === record.id)
      .flatMap((event) => {
        const panel = this.panelOfCore(event.panelId);
        return panel ? [{ panel, event }] : [];
      })
      .sort((a, b) => (this.lastViewed.get(b.panel) ?? 0) - (this.lastViewed.get(a.panel) ?? 0))[0];
    if (loaded) return { chatId: this.chatIdOf(loaded.panel), title: await this.readTitleOf(loaded.panel), place: loaded.event.state.place };
    const row = [...(this.catalogRows.get(this.worktreeProjectKey(authority, record.projectPath)) ?? [])]
      .filter((candidate) => candidate.worktree?.worktreeId === record.id)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    return row?.worktree ? { chatId: row.id, title: storedTitle(row), place: row.worktree.place } : undefined;
  }

  // New Chat in This Worktree's target: a live chat record of an open, trusted project with no finish action running.
  private newChatInTarget(record: WorktreeRecord | undefined): NewChatInWorktreeRequest | undefined {
    const authority = record ? this.authorityOfWorktree(record.id) : undefined;
    const controller = authority === 'local' ? this.worktrees : authority !== undefined ? this.remoteWorktrees.get(authority) : undefined;
    if (record?.kind !== 'chat' || record.deletedAt !== undefined || authority === undefined || controller?.isFinishing(record.id) !== false) return undefined;
    if (authority !== 'local') {
      const project = this.remoteProjects().find((candidate) => candidate.authorityKey === authority && candidate.fsPath === record.projectPath);
      return project && this.remoteFolderTrusted(authority, project.fsPath) ? { projectKey: project.key, worktreeId: record.id } : undefined;
    }
    const projectKey = folderKey(record.projectPath);
    const project = this.projects.folders().find((folder) => folderKey(folder.fsPath) === projectKey);
    return project && this.trust.isTrusted(project.fsPath) ? { projectKey, worktreeId: record.id } : undefined;
  }

  // Rule 14 for a worktree open as its own project: its chats unload and its terminals stop (asked first when one runs a
  // process) before `git worktree remove`; a running conversation refuses.
  private async closeProjectForDelete(projectKey: string): Promise<'closed' | 'cancelled' | { readonly reason: string }> {
    const remote = this.remoteProject(projectKey);
    const project = remote ?? this.projectByKey(projectKey);
    const running = { reason: this.requireLocalization().t('A conversation is running in {0}. Stop it or wait for it to finish, then remove the project.', project.name) };
    if (await this.projectBusy(projectKey)) return running;
    // a remote project closes as Remove Project closes it, its host's terminals asked about first
    if (remote) {
      const hostTerminals = await this.askRemoteTerminals(remote);
      if (hostTerminals === 'cancel') return 'cancelled';
      if (await this.projectBusy(projectKey)) return running;
      this.releaseRemoteTerminals(remote, hostTerminals);
      await this.hostStore?.removeProject(remote.authorityKey, remote.folderKey, remote.key);
      await this.clientFor(remote.authorityKey)?.whenFolderReleased(remote.fsPath);
      return 'closed';
    }
    const terminals = this.requireTerminals();
    if (!(await terminals.confirmKill(terminals.idsIn(projectKey)))) return 'cancelled';
    // a turn may have started while the question was open
    if (await this.projectBusy(projectKey)) return running;
    const loaded = (this.client()?.chats() ?? []).filter((chat) => (chat.folder.ownerKey ?? chat.folder.key) === projectKey);
    for (const chat of loaded) {
      const panel = this.panelOfCore(chat.panelId);
      if (panel && !panel.isDisposed) panel.close();
    }
    await this.projects.remove(project.fsPath);
    await this.hostStore?.removeFromOrder(projectKey);
    await this.client()?.whenFolderReleased(project.fsPath);
    return 'closed';
  }

  // Rule 16's pass, in core: an open project that is a linked worktree gets an adopted record under the open project holding
  // its main worktree.
  private adoptOpenWorktrees(): Promise<void> {
    return this.worktreeEngine.adoptOpenWorktrees(this.desktopProjects().map((project) => ({ key: project.key, fsPath: project.fsPath })));
  }

  // ShellProject.worktreeOf: the project whose main worktree this adopted project's folder belongs to.
  private adoptedProjectName(projectKey: string): string | undefined {
    const record = this.worktreeRecords.records().find((candidate) => candidate.kind === 'adopted' && candidate.deletedAt === undefined && folderKey(candidate.workingFolder) === projectKey);
    if (!record) return undefined;
    if (record.projectPath === undefined) return path.basename(record.repositoryRoot);
    const main = folderKey(record.projectPath);
    return this.desktopProjects().find((project) => project.key === main)?.name ?? path.basename(record.projectPath);
  }

  private requireWorktrees(): WorktreeController {
    if (!this.worktrees) throw new Error('Worktrees used before startup finished');
    return this.worktrees;
  }

  // The worktree controller of the core that holds the project's worktrees.
  private worktreesOf(authority: string): WorktreeController {
    if (authority === 'local') return this.requireWorktrees();
    const known = this.remoteWorktrees.get(authority);
    if (known) return known;
    const askDialog = this.askWorktreeDialog;
    if (!askDialog) throw new Error('Worktrees used before startup finished');
    const controller = new WorktreeController(this.worktreeControllerDeps(authority, this.remoteRecordsOf(authority), askDialog));
    this.remoteWorktrees.set(authority, controller);
    return controller;
  }

  private worktreeRegistry(authority: string): WorktreeRecords | undefined {
    return authority === 'local' ? this.worktreeRecords : this.remoteWorktreeRecords.get(authority);
  }

  // A host's open projects decide which of its records its registry keeps, so a project that joins (a relocated one's new
  // folder) takes the records its core published before; judged again only when that host's project paths changed.
  private recheckRemoteWorktreeRecords(): void {
    for (const [authority, records] of this.remoteWorktreeRecords) {
      const paths = JSON.stringify(this.remoteProjects().filter((project) => project.authorityKey === authority).map((project) => project.fsPath));
      if (this.remoteRecordPaths.get(authority) === paths) continue;
      this.remoteRecordPaths.set(authority, paths);
      records.recheck();
    }
  }

  // A remote host's registry keeps only chat records of its open projects (records.ts remoteChatRecord).
  private remoteRecordsOf(authority: string): WorktreeRecords {
    const known = this.remoteWorktreeRecords.get(authority);
    if (known) return known;
    const os = (): NodeJS.Platform => this.authorityOs(authority);
    const projectPaths = (): string[] => this.remoteProjects().filter((project) => project.authorityKey === authority).map((project) => project.fsPath);
    const records = new WorktreeRecords(remoteChatRecord(projectPaths, os), (line) => log(line), os);
    this.remoteWorktreeRecords.set(authority, records);
    this.disposables.push(records, records.onDidChange(() => this.worktreesChanged()));
    return records;
  }

  // The authority whose registry holds a worktree id; ids are random, so at most one does.
  private authorityOfWorktree(worktreeId: string): string | undefined {
    if (this.worktreeRecords.get(worktreeId)) return 'local';
    return [...this.remoteWorktreeRecords].find(([, records]) => records.get(worktreeId) !== undefined)?.[0];
  }

  // A worktree record's project path is native to its host: a local key is its folder key, a remote one that host's project.
  private worktreeProjectKey(authority: string, projectPath: string): string {
    if (authority === 'local') return folderKey(projectPath);
    const project = this.remoteProjects().find((candidate) => candidate.authorityKey === authority && candidate.fsPath === projectPath);
    if (!project) throw new Error(`${projectPath} is not an open project`);
    return project.key;
  }

  private worktreeRootKey(record: ChatWorktreeRecord, authority: string = 'local'): string {
    return rootKey({ projectKey: this.worktreeProjectKey(authority, record.projectPath), worktreeId: record.id });
  }

  // The finish actions' enablement of a live chat worktree; before the controller exists nothing is enabled.
  private finishStateOf(record: ChatWorktreeRecord): { busy: boolean; hasRemote: boolean; detachedTarget: boolean } {
    const authority = this.authorityOfWorktree(record.id) ?? 'local';
    const controller = authority === 'local' ? this.worktrees : this.remoteWorktrees.get(authority);
    return controller?.finishState(record) ?? { busy: true, hasRemote: false, detachedTarget: true };
  }

  // A remote host's trust is the host store's, for its open projects named by their exact path there.
  private remoteFolderTrusted(authority: string, folder: string): boolean {
    const project = this.remoteProjects().find((candidate) => candidate.authorityKey === authority && candidate.fsPath === folder);
    return project !== undefined && this.requireHostStore().isTrusted(authority, project.folderKey);
  }

  // Main's notices about a remote host's work, with the host's name from this computer's host store beside them, never one a core sent.
  private hostNotices(authority: string): DesktopNotifications {
    return createDesktopNotificationService({
      notice: (severity, message, actions) => this.notificationCenter.notice(severity, message, actions, this.notificationHost(authority)),
      ask: (question, signal) => this.ask({ ...question, message: this.requireLocalization().t('{0}: {1}', this.hostName(authority), question.message) }, signal),
      t: (message) => this.requireLocalization().t(message),
      log: (line) => log(line),
      windowFocused: () => this.window?.isFocused() ?? false,
    });
  }

  // A project's selected chat for its shown folder (D31): its id, and core's worktree state while it is loaded.
  private selectedChatPlace(projectKey: string): { readonly chatId: string; readonly worktreeId?: string; readonly state?: WorktreeStateData } | undefined {
    const chatId = this.lastChats.get(projectKey);
    if (chatId === undefined) return undefined;
    const panel = this.loadedChat(chatId);
    const key = panel ? this.chatKeyOf(panel) : undefined;
    const event = key !== undefined ? this.worktreeStates.get(key) : undefined;
    if (!event) return { chatId };
    return { chatId, ...(event.worktreeId !== undefined ? { worktreeId: event.worktreeId } : {}), state: event.state };
  }

  private worktreeEventOf(panel: DesktopPanel): WorktreeEvent | undefined {
    const key = this.chatKeyOf(panel);
    return key === undefined ? undefined : this.worktreeStates.get(key);
  }

  // Core's state of one chat changed (a turn starting or ending flips its busy): the shown folder, that chat's row, the
  // menu and the chat pool follow; the roots change only with the registry, which worktreesChanged follows.
  private onWorktreeState(event: WorktreeEvent): void {
    const sharedBefore = this.worktreeStates.get(event.panelId)?.state.sharedWith;
    this.worktreeStates.set(event.panelId, event);
    if (sharedBefore !== event.state.sharedWith) this.chatReviews.sharingChanged(event.panelId);
    const panel = this.panelOfCore(event.panelId);
    this.shownFolders.refresh();
    this.refreshScmRoots();
    if (panel) this.chatsChanged(this.projectOf(panel));
    this.refreshMenuState();
    this.scheduleRetention();
  }

  // The registry, the projects or a finish action changed: views keyed by a root follow only a root joining or leaving.
  private worktreesChanged(): void {
    if (this.workspaces) void this.rootSpellings.retain(this.roots.all());
    const roots = this.roots.all().map((root) => root.key);
    const changed = this.rootSet.update(roots);
    if (changed) {
      this.workspaces?.local.format.retain(roots);
      for (const authorityKey of this.authorities?.connectedKeys() ?? []) this.authorities?.connectedWorkspace(authorityKey)?.format.retain(roots);
      this.terminals?.projectsChanged(roots);
      this.fileTree?.projectsChanged();
      this.editorPane?.rootsChanged();
      // a preview's root made before its project registered took no trust
      this.htmlPreviews?.trustChanged();
      this.servedRoots.trustChanged();
      for (const key of changed.removed) this.quickOpenIndex?.invalidate(key);
    }
    // a registry read for the first time decides the saved tabs that waited on it, whether or not a root joined
    this.editorPane?.registriesChanged().catch(this.report('Restoring the tabs of chat worktrees'));
    this.shownFolders.refresh();
    this.refreshScmRoots();
    this.chatsChanged();
    this.refreshMenuState();
    this.shellStateChanged();
  }

  // Source control's projects: every project folder, plus the chat worktrees a project shows, an editor tab names, or a flow
  // pinned (rule 19); a worktree root leaving the list closes its repository.
  private scmRoots(): RootProject[] {
    const kept = new Set(this.pinnedScmRoots);
    for (const shown of Object.values(this.shownFolders.all())) {
      if (shown.worktree) kept.add(rootKey({ projectKey: shown.projectKey, worktreeId: shown.worktree.worktreeId }));
    }
    for (const key of this.editorRootKeys) kept.add(key);
    // a remote project's repositories are its own core's, which runs only while its authority is connected
    return this.roots.all().filter((root) => {
      const authority = authorityKeyOfProject(root.root.projectKey);
      return (authority === 'local' || this.clientFor(authority) !== undefined) && (root.worktree === undefined || kept.has(root.key));
    });
  }

  private refreshScmRoots(): void {
    this.scm?.setProjects(this.scmRoots());
  }

  // Runs work on the repository of a root source control opens for the flow's length.
  private async withScmRoot<T>(key: string, work: (repoId: string) => Promise<T | undefined>): Promise<T | undefined> {
    this.pinnedScmRoots.add(key);
    this.refreshScmRoots();
    try {
      const repoId = await this.requireScm().rootRepositoryWhenReady(key);
      if (repoId === undefined) {
        void this.notifications.warn(this.requireLocalization().t('The worktree\'s repository could not be opened.'));
        return undefined;
      }
      return await work(repoId);
    } finally {
      this.pinnedScmRoots.delete(key);
      this.refreshScmRoots();
    }
  }

  private openWorktreeConflicts(authority: string, folder: string, files: readonly string[], applyBranch?: string): Promise<void> {
    return openWorktreeConflicts({
      liveChatRecordAt: (on, at) => this.worktreeRegistry(on)?.liveChatRecordAt(at),
      worktreeRootKey: (record, on) => this.worktreeRootKey(record, on),
      worktreeProjectKey: (on, at) => this.worktreeProjectKey(on, at),
      withScmRoot: (key, work) => this.withScmRoot(key, work),
      noteWorktreeConflicts: (repoId, conflicted, branch) => this.requireScm().deps.service.noteWorktreeConflicts(repoId, conflicted, branch),
      currentStatus: (repoId) => this.requireScm().deps.service.currentStatus(repoId),
      openMergeEditor: (repoId, path) => this.requireScm().runRequest({ op: 'openMergeEditor', repoId, path }),
    }, authority, folder, files, applyBranch);
  }

  // Per worktree, the project's chats working in it and their latest activity, listed or loaded (the New menu's rows).
  private async worktreeChats(projectKey: string): Promise<Map<string, { count: number; lastActivity: number }>> {
    const rows = await this.chatHost(authorityKeyOfProject(projectKey)).read('Read Chat List', (core) => this.catalogList(core, projectKey));
    // only chats working there, as sharedWith counts them; a loaded chat's live state is newer than its file
    const chats = new Map<string, { worktreeId: string; lastActivity: number } | undefined>();
    for (const row of rows) if (row.worktree?.place === 'worktree') chats.set(row.id, { worktreeId: row.worktree.worktreeId, lastActivity: row.timestamp });
    for (const event of this.worktreeStates.values()) {
      const panel = this.panelOfCore(event.panelId);
      if (!panel || this.projectOf(panel) !== projectKey) continue;
      const id = this.chatIdOf(panel);
      const working = event.worktreeId !== undefined && event.state.place === 'worktree' && event.state.phase === 'ready';
      chats.set(id, working ? { worktreeId: event.worktreeId!, lastActivity: chats.get(id)?.lastActivity ?? 0 } : undefined);
    }
    const byWorktree = new Map<string, { count: number; lastActivity: number }>();
    for (const chat of chats.values()) {
      if (!chat) continue;
      const { worktreeId, lastActivity } = chat;
      const current = byWorktree.get(worktreeId);
      byWorktree.set(worktreeId, { count: (current?.count ?? 0) + 1, lastActivity: Math.max(current?.lastActivity ?? 0, lastActivity) });
    }
    return byWorktree;
  }

  // The sessions whose latest worktree entry names the worktree, stored or loaded.
  private async sessionsUsing(authority: string, worktreeId: string): Promise<string[]> {
    const record = this.worktreeRegistry(authority)?.get(worktreeId);
    const ids = new Set<string>();
    if (record?.projectPath !== undefined) {
      const projectKey = this.worktreeProjectKey(authority, record.projectPath);
      const rows = await this.chatHost(authority).read('Read Chat List', (core) => this.catalogList(core, projectKey));
      for (const row of rows) if (row.worktree?.worktreeId === worktreeId) ids.add(row.id);
    }
    for (const event of this.worktreeStates.values()) if (event.worktreeId === worktreeId && event.sessionId !== undefined) ids.add(event.sessionId);
    return [...ids];
  }

  // Rule 14's first half for a chat worktree (close-worktree.ts): every question first, then what runs there stops.
  private closeWorktreeRoot(authority: string, worktreeId: string, key: string, stop: () => Promise<boolean>): Promise<CloseOutcome> {
    const terminals = this.requireTerminals();
    return closeWorktreeRoot({
      editor: this.requireEditorPane(),
      terminals: { idsIn: (rootKey) => terminals.idsIn(rootKey), confirmKill: (ids) => terminals.confirmKill([...ids]), kill: (id) => terminals.kill(id) },
      closeChats: () => {
        const panels = [...this.worktreeStates.values()].filter((event) => event.worktreeId === worktreeId).flatMap((event) => this.panelOfCore(event.panelId) ?? []);
        for (const panel of panels) this.closeForWorktree(panel);
      },
      rootsChanged: () => this.worktreesChanged(),
      releaseFormatter: (rootKey) => this.workspaces?.forProject(rootKey).format.release(rootKey) ?? Promise.resolve(),
      whenFolderReleased: async () => {
        const record = this.worktreeRegistry(authority)?.get(worktreeId);
        if (!record) return;
        await this.clientFor(authority)?.whenFolderReleased(record.workingFolder);
        // main's own starts there (a search of the root) run on this computer only
        if (authority !== 'local') return;
        const left = await whenProcessesClosed((cwd) => isInsideFolder({ os: process.platform }, record.workingFolder, cwd), FOLDER_PROCESSES_CLOSE_MS);
        if (left.length > 0) log(`[worktrees] processes still run in ${record.workingFolder} after ${FOLDER_PROCESSES_CLOSE_MS} ms; its remove may fail`);
      },
    }, key, stop);
  }

  // A chat closed for a worktree delete does not pull the selection elsewhere; the delete selects its project again after.
  private closeForWorktree(panel: DesktopPanel): void {
    this.closingForWorktree.add(panel);
    const key = this.chatKeyOf(panel);
    if (key !== undefined) this.worktreeStates.delete(key);
    panel.close();
  }

  private worktreeClosed(authority: string, worktreeId: string, removed: boolean): void {
    const projectPath = this.worktreeRegistry(authority)?.get(worktreeId)?.projectPath;
    // a remote project removed meanwhile has no key left to select
    const projectKey = projectPath === undefined ? undefined
      : authority === 'local' ? folderKey(projectPath) : this.remoteProjects().find((project) => project.authorityKey === authority && project.fsPath === projectPath)?.key;
    if (removed && projectKey !== undefined) this.windowLayout.forgetRoot(rootKey({ projectKey, worktreeId }));
    this.worktreesChanged();
    if (this.views && !this.views.selected() && projectKey !== undefined) this.selectProject(projectKey, false).catch(this.report('Selecting a chat after a worktree delete'));
  }

  // Native, as every file picker is (D41); the editor confines the answer to an open project.
  private async pickSavePath(defaultPath: string): Promise<string | undefined> {
    const window = this.window;
    const options = { defaultPath, title: this.requireLocalization().t('Save As') };
    const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    return result.canceled ? undefined : result.filePath;
  }

  private setGrid(grid: ShellGridLayout): void {
    const current = this.windowLayout.sidebar();
    this.windowLayout.setSidebar({ ...current, grid });
    this.shellStateChanged();
    if (current.grid.visible.terminal !== grid.visible.terminal) this.postTerminalShown();
  }

  private terminalToggle(): { shown: boolean; shortcut: string } {
    return { shown: this.windowLayout.sidebar().grid.visible.terminal, shortcut: shellShortcutLabels().toggleTerminal };
  }

  // Every loaded chat's header toggle follows the pane (core posts it as the terminal mirror changes); a chat view that loads
  // later gets it with its ready.
  private postTerminalShown(): void {
    this.core.started()?.terminalToggleChanged();
  }

  // A click shows or hides the pane; Ctrl+` also focuses a shown terminal that lacks focus, as VS Code's toggle does. Showing
  // starts a terminal when there is none and focuses it: both are user actions.
  private toggleTerminal(byKeyboard: boolean): void {
    const shown = this.windowLayout.sidebar().grid.visible.terminal;
    if (shown && (!byKeyboard || this.focusedPart() === 'terminal')) {
      this.toggleGridPane('terminal');
      return;
    }
    if (!shown) this.toggleGridPane('terminal');
    this.focusShownTerminal().catch(this.report('Toggle Terminal'));
  }

  // Once the shells are detected (VS Code's profilesReady) and the saved terminals restored, so a restored terminal is the
  // one focused rather than a new one started ahead of it; nothing when the pane was hidden meanwhile.
  private async focusShownTerminal(): Promise<void> {
    const current = this.currentProjectKey();
    await Promise.all([this.profilesDetected, this.terminalsRestored, this.hostTerminalsDetected(current === undefined ? 'local' : authorityKeyOfProject(current))]);
    if (!this.windowLayout.sidebar().grid.visible.terminal) return;
    const terminals = this.requireTerminals();
    const id = terminals.ensureTerminal();
    if (id !== undefined) terminals.focus(id);
  }

  // Settles once the shells a terminal of this target starts with are known: this computer's, or its remote host's.
  private terminalTargetDetected(projectKey: string | null): Promise<void> {
    const authority = projectKey === null ? 'local' : authorityKeyOfProject(projectKey);
    return authority === 'local' ? this.profilesDetected : this.hostTerminalsDetected(authority);
  }

  // New Terminal: the overlay's pick of a project, then of its host's shells, then the terminal in the shown pane, focused.
  private async newTerminal(): Promise<void> {
    const overlay = this.overlay;
    if (!overlay) return;
    const session = new TerminalPickSession(this.requireTerminals().projectOptions());
    this.terminalPick = session;
    let pick: TerminalPick | undefined;
    try {
      pick = await pickNewTerminal(overlay, session, webContents.getFocusedWebContents() ?? undefined);
    } finally {
      if (this.terminalPick === session) this.terminalPick = undefined;
    }
    if (pick) await this.startPickedTerminal(pick);
  }

  // A New Terminal target's host as main knows it now: its detection, whether it is connected and its listed shells.
  private terminalPickHost(): TerminalPickHost {
    return {
      detected: (projectKey) => this.terminalTargetDetected(projectKey),
      connected: (projectKey) => {
        const authority = projectKey === null ? 'local' : authorityKeyOfProject(projectKey);
        return authority === 'local' || this.authorities?.connectedWorkspace(authority) !== undefined;
      },
      profiles: (projectKey) => this.requireTerminals().profileOptions(projectKey),
    };
  }

  // The toast for a host with no shell to list or start.
  private noShellsText(authority: string): string {
    const { t } = this.requireLocalization();
    return authority === 'local' ? t('No shells were found on this computer.') : t('No shells were found on {0}.', this.hostName(authority));
  }

  private async startPickedTerminal(pick: TerminalPick): Promise<void> {
    const { t } = this.requireLocalization();
    const started = await startPickedTerminal(pick, {
      host: this.terminalPickHost(),
      create: (request) => {
        this.showTerminalPane();
        return this.requireTerminals().create(request, true);
      },
      tell: (message) => void this.notifications.warn(message),
      notConnected: (projectKey) => t('{0} is not connected, so the terminal did not start.', this.hostName(authorityKeyOfProject(projectKey))),
      noShells: (projectKey) => this.noShellsText(projectKey === null ? 'local' : authorityKeyOfProject(projectKey)),
    });
    if (!started.ok) log(`[terminal] New Terminal refused: ${started.reason}`);
  }

  // The New Terminal arrow's menu, built from main's shell lists; resolves once it closed.
  private async openNewTerminalMenu(anchor: OverlayRect): Promise<void> {
    const overlay = this.overlay;
    if (!overlay) return;
    const terminals = this.requireTerminals();
    const { t } = this.requireLocalization();
    const menu = buildNewTerminalMenu(terminals.projectOptions(), (projectKey) => this.hostShellsOf(projectKey), {
      local: t('This computer'),
      home: t('Home folder'),
      detecting: t('Detecting shells…'),
      none: t('No shells found'),
      notConnected: t('Not connected'),
      selectDefault: t('Select Default Profile...'),
    });
    await openNewTerminalMenu(
      overlay,
      menu,
      { label: t('New terminal with a shell'), anchor },
      webContents.getFocusedWebContents() ?? undefined,
      (action) => (action.kind === 'selectDefault' ? this.selectDefaultTerminalProfile() : this.startPickedTerminal({ profileId: action.profileId, target: action.target })),
      (action) => this.report(action.kind === 'selectDefault' ? 'Select Default Profile' : 'New Terminal'),
    );
  }

  // A target's host's shells as main knows them now: still detecting, or its listed profiles.
  private hostShellsOf(projectKey: string | null): HostShells {
    const host = this.hostTerminalsOf(projectKey);
    const ready = host ? host.ready : this.profilesReady;
    return ready ? { kind: 'detected', profiles: this.requireTerminals().profileOptions(projectKey) } : { kind: 'detecting' };
  }

  // A terminal's links resolve through its project's workspace: this computer's, or a remote authority's while it is usable.
  private linksReachable(base: LinkBase): boolean {
    const authority = authorityKeyOfProject(base.project.key);
    return authority === 'local' || this.authorities?.connectedWorkspace(authority) !== undefined;
  }

  // A link clicked in an editor tab: one in a remote file or a host's text goes through the link checks, as a remote terminal's does.
  private async openEditorLink(request: EditorOpenLink): Promise<void> {
    const authority = this.requireEditorPane().linkAuthority(request.tabId);
    if (authority === undefined) return;
    if (authority === 'local') await this.requirePlatform().shell.openExternal(request.url);
    else await this.requireOpenUrl().userClick(authority, request.url);
  }

  // A web link clicked in a terminal: a remote terminal's is forwarded and opened through the link checks with no notice.
  private async openTerminalWebLink(request: TerminalOpenWebLink): Promise<void> {
    const authority = this.requireTerminals().authorityOf(request.id);
    if (authority === undefined) return;
    if (authority === 'local') await this.requirePlatform().shell.openExternal(request.url);
    else await this.requireOpenUrl().userClick(authority, request.url);
  }

  // A terminal link click: resolved again here, then a file opens in the editor (focused, a user's action) and a folder in Files.
  private async openTerminalLink(request: TerminalOpenLink): Promise<void> {
    const base = this.requireTerminals().linkBase(request.id);
    if (!base || !this.linksReachable(base)) return;
    const link = await this.terminalLinks.resolveFresh(request.path, base);
    if (!link) return;
    if (link.kind === 'folder') {
      const action = folderLinkAction(base.project, link.relativePath, this.currentProjectKey());
      if (action.kind === 'reveal') this.shell?.revealInFiles(action.file);
      else await this.openQuickOpen('files', action.scope);
      return;
    }
    await this.requireEditorPane().openFromUser(base.project.key, link.relativePath, {
      ...(request.line !== null ? { line: request.line } : {}),
      ...(request.column !== null ? { column: request.column } : {}),
    });
  }

  // Join Terminals... is enabled for the command target while its group has room and another panel terminal is outside it.
  private terminalJoinable(): boolean {
    const terminals = this.terminals;
    const id = terminals?.commandTarget();
    return !!terminals && !!id && terminals.joinRoom(id) > 0 && terminals.joinCandidates(id).length > 0;
  }

  // Join Terminals... (VS Code's joinInstances) anchored on id: the terminals picked join its group, at most its free slots.
  private async joinTerminals(anchorId: string): Promise<void> {
    const terminals = this.requireTerminals();
    const candidates = new Set(terminals.joinCandidates(anchorId));
    const max = Math.min(terminals.joinRoom(anchorId), candidates.size);
    if (max === 0) return;
    const { t } = this.requireLocalization();
    const ask = createQuickPickManyAsker({
      overlay: () => this.overlay,
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      unavailable: () => void this.notifications.error(t('The list could not be shown, so nothing was changed. Try again.')),
      tooLarge: () => void this.notifications.error(t('The list has too many entries to show, so nothing was changed.')),
      log: (line) => log(line),
    });
    const items = joinTerminalItems(terminals.state().terminals.filter((terminal) => candidates.has(terminal.id)));
    const picked = await ask(t('Select the terminals to join'), items, max);
    if (picked) terminals.join(anchorId, picked);
  }

  private async pickTerminalIcon(id: string): Promise<void> {
    const overlay = this.overlay;
    const appearance = this.requireTerminals().appearance(id);
    if (!overlay || !appearance) return;
    const t = (message: string): string => this.requirePlatform().localization.t(message);
    const icons: Record<TerminalCustomIcon, string> = {
      'terminal': t('Terminal'),
      'square-terminal': t('Console'),
      'code': t('Code'),
      'bug': t('Bug'),
      'rocket': t('Rocket'),
      'server': t('Server'),
      'database': t('Database'),
      'cloud': t('Cloud'),
      'container': t('Container'),
      'package': t('Package'),
      'git-branch': t('Branch'),
      'globe': t('Globe'),
      'cpu': t('Processor'),
      'monitor': t('Monitor'),
      'flask-conical': t('Flask'),
      'activity': t('Activity'),
      'gauge': t('Gauge'),
      'zap': t('Lightning'),
      'flame': t('Flame'),
      'sparkles': t('Sparkles'),
      'star': t('Star'),
      'heart': t('Heart'),
      'wrench': t('Wrench'),
      'bot': t('Bot'),
    };
    const labels = { placeholder: t('Select an icon for the terminal'), profileIcon: t('Default'), icons };
    const picked = await pickTerminalIcon(overlay, appearance, labels, webContents.getFocusedWebContents() ?? undefined);
    if (picked) this.requireTerminals().setCustomIcon(id, picked.customIcon);
  }

  private async pickTerminalColor(id: string): Promise<void> {
    const overlay = this.overlay;
    const appearance = this.requireTerminals().appearance(id);
    if (!overlay || !appearance) return;
    const t = (message: string): string => this.requirePlatform().localization.t(message);
    const colors: Record<TerminalColor, string> = {
      black: t('Black'),
      red: t('Red'),
      green: t('Green'),
      yellow: t('Yellow'),
      blue: t('Blue'),
      magenta: t('Magenta'),
      cyan: t('Cyan'),
      white: t('White'),
    };
    const picked = await pickTerminalColor(overlay, appearance, { placeholder: t('Select a color for the terminal'), noColor: t('No color'), colors }, webContents.getFocusedWebContents() ?? undefined);
    if (picked) this.requireTerminals().setColor(id, picked.color);
  }

  // Each host keeps its own default: this computer's in its user setting, a remote host's in its host record. The hosts are
  // this computer and those of the open projects, in the sidebar's group order; the choice comes from main's own shell list.
  private async selectDefaultTerminalProfile(): Promise<void> {
    const overlay = this.overlay;
    if (!overlay) return;
    const platform = this.requirePlatform();
    const { t } = platform.localization;
    const projects = this.requireTerminals().projectOptions();
    const reachableOn = (authority: string): string | undefined => projects.find((project) => project.reachable && authorityKeyOfProject(project.key) === authority)?.key;
    const listed = [...new Set(['local', ...projects.map((project) => authorityKeyOfProject(project.key))])];
    const hosts = (this.hostStore?.groups(listed) ?? listed).map((authority): DefaultProfileHost => ({
      authority,
      name: authority === 'local' ? t('This computer') : this.hostName(authority),
      reachable: authority === 'local' || reachableOn(authority) !== undefined,
      saved: authority === 'local' || this.savedHostRecord(authority) !== undefined,
    }));
    const picked = await pickDefaultProfile(overlay, hosts, {
      shellsOf: (authority) => {
        const key = authority === 'local' ? null : reachableOn(authority);
        return key === undefined ? { kind: 'detected', profiles: [] } : this.hostShellsOf(key);
      },
      detected: (authority) => (authority === 'local' ? this.profilesDetected : this.hostTerminalsDetected(authority)),
      tell: (message) => void this.notifications.warn(message),
    }, {
      hostPlaceholder: t('Select the host whose default terminal profile to set'),
      notConnected: t('Not connected'),
      detecting: t('Detecting shells…'),
      profilePlaceholder: (host) => (host.authority === 'local' ? t('Select your default terminal profile') : t('Select the default terminal profile for {0}', host.name)),
      noShells: (host) => this.noShellsText(host.authority),
      unsaved: (host) => t('{0} is not a saved host, so its default terminal profile cannot be kept.', host.name),
    }, webContents.getFocusedWebContents() ?? undefined);
    if (!picked) return;
    if (picked.authority === 'local') {
      await writeDesktopSetting(platform.settings, TERMINAL_DEFAULT_PROFILE_SETTING, picked.profileId);
      return;
    }
    const hostId = this.savedHostIdOf(picked.authority);
    if (hostId !== undefined) await this.requireHostStore().setDefaultTerminalProfile(hostId, picked.profileId);
  }

  private showTerminalPane(): void {
    if (!this.windowLayout.sidebar().grid.visible.terminal) this.toggleGridPane('terminal');
  }

  // Settings › Terminal: the listed profiles, the detected ones a null entry hides, and the entries main refused.
  private terminalProfileReport(): TerminalProfileReport {
    const catalog = this.terminalProfiles;
    return { profiles: this.requireTerminals().profileOptions(), hidden: [...(catalog?.hidden() ?? [])], problems: [...(catalog?.problems() ?? [])] };
  }

  // Focus Next or Previous Terminal: the terminal pane shows, and the terminal takes keyboard focus.
  private focusRelativeTerminal(delta: 1 | -1): void {
    const terminals = this.requireTerminals();
    const id = terminals.relative(delta);
    if (id === undefined) return;
    if (!this.windowLayout.sidebar().grid.visible.terminal) this.toggleGridPane('terminal');
    terminals.select(id);
    terminals.focus(id);
  }

  // The palette's Rename...: the shell renames the command target in place.
  private renameActiveTerminal(): void {
    const id = this.revealTerminalTarget();
    if (id !== undefined) this.shell?.startTerminalRename(id);
  }

  // The palette's Copy Last Command, Copy Last Command Output, Add to Chat and Scroll to Previous or Next Command: the shell
  // carries them out on the command target's buffer, which takes keyboard focus (a user action).
  private runTerminalAction(action: TerminalAction): void {
    const id = this.revealTerminalTarget();
    if (id !== undefined) this.shell?.runTerminalAction(id, action);
  }

  // The command target shows where it is: the terminal pane, or its editor tab, active, with the editor pane shown.
  private revealTerminalTarget(): string | undefined {
    const target = this.requireTerminals().target();
    if (!target) return undefined;
    if (target.placement === 'panel') this.showTerminalPane();
    else this.editorPane?.showTerminalTab(terminalTabId(target.id), { focus: false });
    return target.id;
  }

  // G25: the shell's selection or a command's output becomes a pending attachment of the current chat, labelled from main's own
  // facts and bounded again here.
  private async addTerminalOutputToChat(request: TerminalAddToChat): Promise<void> {
    const terminals = this.requireTerminals();
    const title = terminals.titleOf(request.id);
    const projectKey = terminals.state().terminals.find((terminal) => terminal.id === request.id)?.projectKey;
    if (title === undefined || projectKey === undefined) return;
    const facts = request.commandId === null ? undefined : terminals.commandFacts(request.id, request.commandId);
    const capped = capTerminalText(request.text);
    const attachment = {
      kind: 'terminal' as const,
      source: request.source,
      commandLine: facts && facts.commandLine !== '' ? facts.commandLine : null,
      exitCode: facts?.exitCode ?? null,
      terminalTitle: title,
      text: capped.text,
      omittedLines: Math.min(request.omittedLines + capped.omittedLines, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES),
    };
    await this.addAttachmentToChat(projectKey, attachment, this.requireLocalization().t('The chat could not be loaded, so the terminal output was not added to it.'));
  }

  // What one host holds never goes into a chat of another; the text names both places.
  private crossAuthorityRefusal(chatAuthority: string, from: string): string {
    const { t } = this.requireLocalization();
    const name = (key: string): string => (key === 'local' ? t('This computer') : this.hostName(key));
    return t('This chat runs on {0}, so it cannot take what is on {1}.', name(chatAuthority), name(from));
  }

  // Add to Chat from a terminal or the Graph: a pending attachment of the current chat (the selected one, else a new chat in
  // the project of root, a project key or a chat worktree's root key, or the default target for none); prompt, when given, joins
  // the composer's draft. The composer takes focus, as the user asked. notLoaded: the warning when the chat could not be loaded.
  // The attachment is text main or core already read, so a chat on any host takes it, as it takes a pasted image.
  private async addAttachmentToChat(root: string | null, attachment: ChatAttachmentInput, notLoaded: string, prompt?: string): Promise<void> {
    const projectKey = root === null ? undefined : parseRootKey(root)?.projectKey;
    const authority = this.views?.selected()?.authority ?? authorityKeyOfProject(projectKey ?? '');
    await this.chatHost(authority).run('Add to Chat', async (core) => {
      if (!this.views?.selected()) await this.newChatIn(core, projectKey !== undefined && this.isKnownProject(projectKey, core) ? projectKey : undefined);
      const panel = this.views?.selected();
      // A chat still restoring is the chat the attachment goes to, once core registered it.
      const restored = panel ? await this.restoredCorePanel(panel) : undefined;
      const corePanelId = restored?.corePanelId;
      if (restored?.failed) {
        void this.notifications.warn(notLoaded);
        return;
      }
      if (!panel || corePanelId === undefined || !(await this.entryActionDeps.whenReady(panel)) || this.views?.selected() !== panel) {
        log(`[${attachment.kind}] Add to Chat: the chat closed before it was ready`);
        return;
      }
      if (!(await core.client.addAttachment(corePanelId, attachment, prompt))) return;
      this.views?.focusChat();
    });
  }

  // Edit › Paste and Cmd+V: a terminal whose xterm has keyboard focus pastes through main; anything else (a terminal's Find box
  // or rename field included) gets what the paste roles do, which on macOS also reaches native dialogs' text fields.
  private paste(matchStyle: boolean): void {
    const id = this.terminals?.commandTarget() ?? null;
    if (id !== null && this.terminalInputHasFocus()) {
      this.terminalPaste.allow('clipboard');
      this.shell?.requestTerminalPaste(id);
      return;
    }
    if (process.platform === 'darwin') {
      Menu.sendActionToFirstResponder(matchStyle ? 'pasteAndMatchStyle:' : 'paste:');
      return;
    }
    webContents.getFocusedWebContents()?.paste();
  }

  private layoutMove(pane: GridPane, slot: GridSlot): void {
    this.setGrid(moveGridPane(this.windowLayout.sidebar().grid, pane, slot));
  }

  // Hiding the editor while it, or its page tab's view, holds focus gives focus to the chat.
  private toggleGridPane(pane: 'editor' | 'terminal'): void {
    const grid = this.windowLayout.sidebar().grid;
    const next = toggleGridPane(grid, pane);
    const focused = this.focusedPart() === pane;
    this.setGrid(next);
    if (!next.visible[pane] && focused) this.views?.focusChat();
  }

  private async openQuickOpen(mode: QuickOpenMode, scope?: QuickOpenScope): Promise<void> {
    const picker = this.quickOpenPicker;
    if (!picker) return;
    const outcome = await picker.show(webContents.getFocusedWebContents() ?? undefined, mode, scope);
    if (!outcome) return;
    // The overlay has hidden and given focus back, so the command acts where the user was.
    if (outcome.kind === 'command') {
      this.requirePalette().run(outcome.id, outcome.context);
      return;
    }
    const pick = outcome.pick;
    const position = { ...(pick.line !== undefined ? { line: pick.line } : {}), ...(pick.column !== undefined ? { column: pick.column } : {}) };
    if (pick.kind === 'path') {
      // its host may have gone away since the query returned it, and its path may lead to a share now
      const opened = await this.requireEditorPane().openPathFromUser(pick.authority, pick.path, position).catch((err: unknown) => {
        if (err instanceof NotConnectedError || err instanceof RefusedPathError) return err;
        log(`[quick-open] opening ${pick.path} on ${pick.authority} failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
      const { t, render } = this.requireLocalization();
      if (opened instanceof NotConnectedError) void this.notifications.warn(t('{0} is not connected.', this.hostName(pick.authority)));
      else if (opened instanceof RefusedPathError) void this.notifications.warn(render(opened.text));
      else if (!opened) void this.notifications.warn(t('{0} could not be opened.', pick.path));
      return;
    }
    if (pick.mention) {
      await this.mentionInSelectedChat({ projectKey: pick.projectKey, relativePath: pick.relativePath });
      return;
    }
    await this.requireEditorPane().openFromUser(pick.projectKey, pick.relativePath, position);
  }

  // Files' and Source Control's Mention in chat, the editor's mention button and Quick Open's @ mention in the selected chat.
  // A chat still restoring is the chat the file goes to, once core registered it.
  private async mentionInSelectedChat(target: AuthorityMentionTarget): Promise<void> {
    const authority = this.views?.selected()?.authority ?? 'local';
    const from = crossedByMention(authority, target);
    if (from !== undefined && this.views?.selected()) {
      void this.notifications.warn(this.crossAuthorityRefusal(authority, from));
      return;
    }
    await this.chatHost(authority).run('Mention', async (core) => {
      const selected = this.views?.selected();
      const restored = selected ? await this.restoredCorePanel(selected) : undefined;
      const corePanelId = restored?.corePanelId;
      // A chat page drops a message core posts before it is ready.
      if (!selected || corePanelId === undefined || !(await this.entryActionDeps.whenReady(selected))) {
        const { t } = this.requireLocalization();
        void this.notifications.warn(restored?.failed ? t('The chat could not be loaded, so the file was not mentioned in it.') : t('Open a chat to mention a file in it.'));
        return;
      }
      await core.client.mention(corePanelId, target);
    });
  }

  private openLogTab(filePath: string, preserveFocus: boolean): void {
    this.editorPane?.openLog(filePath, !preserveFocus).catch(this.report('Show Log'));
  }

  private notificationsChanged(): void {
    this.taskbar.update(this.notificationCenter.bell().unseen);
    this.shellStateChanged();
    if (this.overlay?.isOpen('notifications')) this.overlay.send(OVERLAY_CHANNELS.notificationsState, this.notificationCenter.state());
  }

  // The chat the user is looking at: the selected one, while the window has focus (D52's read rule).
  private viewedChat(): ChatKey | undefined {
    const selected = this.views?.selected();
    if (!selected || !this.window || this.window.isDestroyed() || !this.window.isFocused()) return undefined;
    const sessionId = this.sessionIdOf(selected);
    return { panelId: selected.panelId, ...(sessionId !== undefined ? { sessionId } : {}) };
  }

  private notificationProject(key: string): NotificationProject {
    const authority = authorityKeyOfProject(key);
    if (authority !== 'local') {
      const remote = this.remoteProject(key);
      return { key, name: this.clientFor(authority)?.resolve(key)?.label ?? remote?.name ?? key };
    }
    const folder = this.projects.folders().find((candidate) => folderKey(candidate.fsPath) === key);
    const name = this.client()?.resolve(key)?.label ?? folder?.name;
    return { key, name: name ?? path.basename(key) };
  }

  // The chat a notification is about, with a title from the catalog when main has not read one yet.
  private async describeChat(corePanelId: string): Promise<ChatRef | undefined> {
    const panel = this.panelOfCore(corePanelId);
    const projectKey = panel ? this.projectOf(panel) : undefined;
    if (!panel || projectKey === undefined) return undefined;
    const sessionId = this.sessionIdOf(panel);
    const title = await this.readTitleOf(panel);
    return {
      panelId: panel.panelId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      project: this.notificationProject(projectKey),
      title,
      // the host store's name, never one a core sent
      ...(panel.authority !== 'local' ? (({ name, color }) => ({ host: name, ...(color !== undefined ? { hostColor: color } : {}) }))(this.notificationHost(panel.authority)) : {}),
    };
  }

  // Selecting shows the chat, and core posts panelFocused (which focuses the composer) inside that show, so a message an
  // entry's action posts reaches the chat after it.
  private readonly entryActionDeps: EntryActionDeps<DesktopPanel> = {
    selected: () => this.views?.selected(),
    // A refusal (another process's lease, a deleted chat) shows its toast.
    select: async (chat: ChatRef) => {
      const views = this.views;
      if (!views) return undefined;
      const loaded = views.panel(chat.panelId);
      const chatId = loaded && views.chats().includes(loaded) ? this.chatIdOf(loaded) : chat.sessionId ?? `${NEW_CHAT_ID_PREFIX}${chat.panelId}`;
      const result = await this.selectChat(chatId, authorityKeyOfProject(chat.project.key));
      return result.ok ? this.loadedChat(chatId) : undefined;
    },
    // AD11: a message for a chat's UI goes out once that chat's view is ready, so a chat that just loaded never drops it.
    whenReady: async (panel) => {
      const corePanelId = this.corePanelIdOf(panel);
      const client = this.clientOf(panel);
      if (!client || corePanelId === undefined) {
        log('[notifications] the chat is not ready for its action');
        return false;
      }
      return client.whenReady(corePanelId);
    },
    post: (panel, message) => {
      const corePanelId = this.corePanelIdOf(panel);
      if (corePanelId !== undefined) this.clientOf(panel)?.post(corePanelId, message).catch(this.report('Posting to a chat'));
    },
  };

  // A remote project's badge: its host as this computer names it.
  private shellAuthority(authorityKey: string): ShellProject['authority'] {
    const color = this.hostColor(authorityKey);
    const kind = authorityKey === 'loopback' ? 'loopback' : this.hostAuthority(authorityKey)?.kind;
    if (kind === undefined) throw new Error(`No saved host is named ${authorityKey}`);
    return { key: authorityKey, kind, hostId: this.hostIdOf(authorityKey), name: this.hostName(authorityKey), ...(color !== undefined ? { color } : {}) };
  }

  // false only while the authority is connected to a daemon that does not list TRANSFER_FEATURES; this computer always carries them
  private carriesTransfers(authorityKey: string): boolean {
    if (authorityKey === 'local') return true;
    const connection = this.authorities?.connection(authorityKey);
    return connection === undefined || carriesTransfers(connection.features);
  }

  // A remote authority's state; an SSH host's cancelled attempt leaves it offline, not failed.
  private connectionOf(authorityKey: string): ShellProject['connection'] {
    const hostId = this.savedHostIdOf(authorityKey);
    if (hostId !== undefined && this.remoteHosts) return this.remoteHosts.connectionOf(hostId);
    return this.authorities?.state(authorityKey) ?? 'offline';
  }

  // Each project's loaded chats that run and that wait on the user.
  private projectCounts(views: PanelViews): Map<string, { running: number; waiting: number }> {
    const counts = new Map<string, { running: number; waiting: number }>();
    for (const chat of views.chats()) {
      const key = this.projectOf(chat);
      if (key === undefined) continue;
      const status = statusOf(this.activityOf(chat));
      const count = counts.get(key) ?? { running: 0, waiting: 0 };
      if (status === 'running') count.running++;
      if (status === 'waiting') count.waiting++;
      counts.set(key, count);
    }
    return counts;
  }

  // The overlay's and the notifier's state: the UI language, and the characters Quick Open and the notifications draw.
  private overlayState(): OverlayState {
    const characters = this.overlayCharacterState();
    return { locale: this.requireLocalization().language, platform: shellPlatform(process.platform), ...(characters ? { characters } : {}) };
  }

  private overlayCharacterState(): OverlayState['characters'] {
    const shown = currentCharacters();
    if (!shown) return undefined;
    const counts = this.views ? [...this.projectCounts(this.views)] : [];
    const states = Object.fromEntries(counts.flatMap(([key, count]) => {
      const state = characterState(count);
      return state === 'idle' ? [] : [[key, state] as const];
    }));
    const selected = this.selectedProjectKey;
    return { shown, states, ...(selected !== undefined ? { selected } : {}) };
  }

  private shellState(views: PanelViews): Omit<ShellState, 'revision'> {
    const client = this.client();
    const defaultKey = client?.defaultTarget()?.key;
    const counts = this.projectCounts(views);
    const { t } = this.requireLocalization();
    const local = this.projects.folders().map((folder): ShellProject => {
      const key = folderKey(folder.fsPath);
      const branch = client?.branchOf(key);
      const worktreeOf = this.adoptedProjectName(key);
      const wsl = process.platform === 'win32' ? wslUncToLinux(folder.fsPath) : undefined;
      const devcontainerConfig = this.devcontainerConfigs.get(key);
      const presence = this.presences.of(key);
      const relocation = this.relocationOf(key);
      return {
        key,
        name: client?.resolve(key)?.label ?? folder.name,
        fsPath: folder.fsPath,
        trusted: this.trust.isTrusted(folder.fsPath),
        authority: { key: 'local', kind: 'local', name: t('This computer') },
        platform: shellPlatform(process.platform),
        connection: 'connected',
        trash: true,
        ...(branch !== undefined ? { branch } : {}),
        ...(worktreeOf !== undefined ? { worktreeOf } : {}),
        running: counts.get(key)?.running ?? 0,
        waiting: counts.get(key)?.waiting ?? 0,
        ...(wsl ? { wsl } : {}),
        ...(wsl && this.hostStore?.isWslNoticeDismissed(key) ? { wslNoticeDismissed: true as const } : {}),
        ...(devcontainerConfig !== undefined ? { devcontainerConfig } : {}),
        ...(presence === 'missing' || presence === 'unavailable' ? { presence } : {}),
        ...(relocation ? { relocation } : {}),
      };
    });
    const remote = this.remoteProjects().map((project): ShellProject => {
      const branch = this.clientFor(project.authorityKey)?.branchOf(project.key);
      const devcontainerConfig = this.devcontainerConfigs.get(project.key);
      const presence = this.presenceOf(project.key);
      const relocation = this.relocationOf(project.key);
      return {
        key: project.key,
        name: project.name,
        fsPath: project.fsPath,
        trusted: this.isProjectTrusted(project),
        authority: this.shellAuthority(project.authorityKey),
        platform: project.os,
        connection: this.connectionOf(project.authorityKey),
        trash: false,
        ...(this.carriesTransfers(project.authorityKey) ? {} : { transfersUnsupported: true as const }),
        ...(branch !== undefined ? { branch } : {}),
        running: counts.get(project.key)?.running ?? 0,
        waiting: counts.get(project.key)?.waiting ?? 0,
        ...(devcontainerConfig !== undefined ? { devcontainerConfig } : {}),
        ...(presence === 'missing' || presence === 'unavailable' ? { presence } : {}),
        ...(relocation ? { relocation } : {}),
        ...(presence !== 'present' && !this.relocatesOn(project.authorityKey) ? { locateUnsupported: true as const } : {}),
      };
    });
    // the palette mark of a project with its own look
    const marked = (project: ShellProject): ShellProject => {
      const look = projectLookOf(project.key);
      return look ? { ...project, look: look.mode } : project;
    };
    const byKey = new Map([...local, ...remote].map((project) => [project.key, marked(project)]));
    const projects = (this.hostStore?.order([...byKey.keys()]) ?? [...byKey.keys()]).map((key) => byKey.get(key)!);
    const shownChat = views.selected();
    const selected = this.selectedProjectChat(shownChat);
    const selectedId = selected ? this.chatIdOf(selected) : undefined;
    const selectedTitle = selected ? this.titleOf(selected) : undefined;
    const selectedDesign = selected ? this.designOf(selected) : undefined;
    const projectKey = this.selectedProjectKey ?? defaultKey;
    const safeStart = safeStartReason();
    const kept = this.agentThemes.keepState();
    const keepChanges = kept && shownKeepChanges(kept, this.requireLocalization());
    const themeProposal = this.agentThemes.proposalStrip();
    const screenshotNotice = this.agentThemes.screenshotNotice();
    const wallpapers = currentWallpapers();
    const characters = currentCharacters();
    return {
      locale: this.requireLocalization().language,
      platform: shellPlatform(process.platform),
      windowState: windowStateOf(this.window),
      projects,
      selected: { ...(projectKey !== undefined ? { projectKey } : {}), ...(selectedId !== undefined ? { chatId: selectedId } : {}) },
      chatViewShown: shownChat !== undefined && !this.chatWithheld(shownChat),
      chatModal: shownChat !== undefined && !this.chatWithheld(shownChat) && shownChat.modalOpen,
      ...(selected && selectedId !== undefined ? { selectedChat: { id: selectedId, ...(selectedTitle !== undefined ? { title: selectedTitle } : {}), status: statusOf(this.activityOf(selected)), ...(selectedDesign !== undefined ? { design: selectedDesign } : {}) } } : {}),
      effectiveTheme: currentThemeKind(),
      layout: this.windowLayout.sidebar(),
      layoutRevision: this.layoutRevision,
      dockInset: this.themeDock?.isOpen() === true ? THEME_DOCK_REM : 0,
      dockPeek: this.themeDock?.peeking() === true,
      ...(safeStart !== undefined ? { safeStart: { reason: safeStart } } : {}),
      ...(keepChanges ? { keepChanges } : {}),
      ...(themeProposal ? { themeProposal } : {}),
      ...(screenshotNotice ? { screenshotNotice } : {}),
      themeRevision: currentThemeRevision(),
      ...(wallpapers ? { wallpapers: wallpapers.regions, wallpaperPaused: currentWallpaperMotion().paused } : {}),
      ...(characters ? { characters } : {}),
      shortcuts: shellShortcutLabels(),
      notifications: this.notificationCenter.bell(),
      engineHalted: this.core.halted(),
      engines: this.engines(),
      hosts: this.requireRemoteHosts().shellHosts(),
      search: shellSearchSettings(this.requirePlatform().settings),
      shownFolders: this.shownFolders.all(),
      sidebar: { alwaysShowHeaderActions: this.requirePlatform().settings.get<unknown>(SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING) === true },
      projectsView: this.requirePlatform().settings.get<unknown>(PROJECTS_VIEW_SETTING) === 'grouped' ? 'grouped' : 'flat',
      projectGroups: this.projectGroups(projects.map((project) => project.key)),
    };
  }

  // The grouped view's groups of the shown projects in the stored group order, and which of them are collapsed.
  private projectGroups(shownKeys: readonly string[]): ShellState['projectGroups'] {
    const groups = groupsOf(shownKeys);
    const order = this.hostStore?.groups(groups) ?? groups;
    return { order, collapsed: (this.hostStore?.collapsedGroups() ?? []).filter((group) => order.includes(group)) };
  }

  // A design chat its catalog has not listed yet: nested under its parent and named by its panel's title, the name core gives its
  // session, which its stored row will have.
  private unlistedDesignRow(chat: DesktopPanel): Pick<ShellChat, 'title' | 'design'> {
    const parent = this.designParents.get(chat);
    if (!parent) return { title: '' };
    const parentChat = this.views?.chats().find((candidate) => candidate === parent);
    return { title: panelTitle(chat.title), design: parentChat ? { parentId: this.chatIdOf(parentChat) } : {} };
  }

  // A loaded chat's design role as its chat list row has it.
  private designOf(panel: DesktopPanel): ShellChat['design'] {
    const sessionId = this.sessionIdOf(panel);
    const projectKey = this.projectOf(panel);
    const row = sessionId === undefined || projectKey === undefined ? undefined : this.catalogRows.get(projectKey)?.find((session) => session.id === sessionId);
    return row ? shellDesignOf(row) : this.unlistedDesignRow(panel).design;
  }

  // undefined while the chat has a session no catalog read has titled yet; '' for a chat with no title
  private titleOf(panel: DesktopPanel): string | undefined {
    const sessionId = this.sessionIdOf(panel);
    const projectKey = this.projectOf(panel);
    if (sessionId === undefined) this.untitledChats.add(panel);
    if (sessionId === undefined || projectKey === undefined) return '';
    const known = this.knownTitles.get(panel.authority) ?? new Map<string, string>();
    const rows = this.catalogRows.get(projectKey);
    const title = chatTitle(rows, known, sessionId, this.untitledChats.has(panel));
    if (title === undefined) return undefined;
    // only a read titles the session; New chat stands in until one does
    if (!rows?.some((row) => row.id === sessionId) && !known.has(sessionId)) return title;
    this.untitledChats.delete(panel);
    known.set(sessionId, title);
    this.knownTitles.set(panel.authority, known);
    return title;
  }

  // titleOf, after a catalog read when main has not read the chat's title yet
  private async readTitleOf(panel: DesktopPanel): Promise<string> {
    const projectKey = this.projectOf(panel);
    if (this.titleOf(panel) === undefined && projectKey !== undefined && this.clientOf(panel)) {
      await this.chatHost(panel.authority).read('Read Chat List', (core) => this.catalogList(core, projectKey)).catch(this.report('Reading the chat list'));
    }
    return this.titleOf(panel) ?? '';
  }

  private shellStateChanged(): void {
    // the selected project's own look follows the selection here, once the selection state is whole; its theme listeners
    // end in this function again
    setSelectedProject(this.selectedProjectKey);
    this.views?.withholdingChanged();
    this.shell?.stateChanged();
    const characters = JSON.stringify(this.overlayCharacterState() ?? null);
    if (characters !== this.overlayCharacters) {
      this.overlayCharacters = characters;
      this.overlay?.stateChanged();
      this.notifier.stateChanged();
    }
    this.updateWindowTitle();
    this.publishHostAttention();
    this.publishChatConnections();
    this.publishVisibleAuthorities();
  }

  // The remote authority of the project the window shows, while the window is shown and not minimized.
  private publishVisibleAuthorities(): void {
    const window = this.window;
    const shown = window !== undefined && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    const key = this.selectedProjectKey;
    const authority = key === undefined ? 'local' : authorityKeyOfProject(key);
    this.setVisibleRemoteAuthorities(shown && authority !== 'local' ? [authority] : []);
  }

  // undefined: every project's list. With no core (a reload or quit tore it down), or while a closing window or core closes
  // the chats with their states kept, there is no list to fetch; the chats announce themselves again as they reopen.
  private chatsChanged(projectKey?: string): void {
    const shell = this.shell;
    if (!shell || !this.core.current() || this.views?.retainingStates) return;
    if (projectKey !== undefined) {
      shell.chatsChanged(projectKey);
      return;
    }
    for (const folder of this.projects.folders()) shell.chatsChanged(folderKey(folder.fsPath));
    for (const project of this.remoteProjects()) shell.chatsChanged(project.key);
    const defaultKey = this.client()?.defaultTarget()?.key;
    if (defaultKey !== undefined) shell.chatsChanged(defaultKey);
  }

  // A folder switch moves the selected chat, and so does its folder leaving the project list; the selection follows it.
  private followSelectedChat(): void {
    const selected = this.views?.selected();
    if (selected && !this.chatElsewhereSelected() && this.projectOf(selected) !== this.selectedProjectKey) this.selectionChanged(selected);
  }

  // A remote project is selected whose core has not opened a chat yet, while the chat view keeps another authority's chat.
  private chatElsewhereSelected(): boolean {
    const selected = this.views?.selected();
    return selected !== undefined && this.selectedProjectChat(selected) === undefined;
  }

  private chatWithheld(chat: DesktopPanel): boolean {
    return this.keptBesideAbsentProject(chat) || keptChatWithheld(this.selectedProjectKey, chat, (authority) => this.hostAttentionOf(authority));
  }

  private viewsChanged(): void {
    this.chatFoldersChanged.fire();
    this.overlaySettings?.selectionChanged();
    this.followSelectedChat();
    this.shellStateChanged();
    this.refreshMenuState();
    this.scheduleRetention();
  }

  private updateWindowTitle(): void {
    const selected = this.views?.selected();
    if (!selected || !this.window || this.window.isDestroyed()) return;
    const shown = this.selectedProjectChat(selected);
    const title = shown ? this.titleOf(shown) : '';
    this.window.setTitle(title ? `${title} - Damocles` : 'Damocles');
  }

  // The main window's child view that shows `contents`; the window's own page is not a child view.
  private windowView(contents: WebContents): WebContentsView | undefined {
    const window = this.window;
    if (!window || window.isDestroyed()) return undefined;
    return window.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView && child.webContents === contents);
  }

  private focusedPart(): FocusPart | undefined {
    const views = this.views;
    if (!views) return undefined;
    if (this.notifier.focused) return 'toasts';
    if (this.browserTabs?.focused() || this.designPreviews?.focused() || this.htmlPreviews?.focused()) return 'editor';
    if (views.chatFocused()) return 'chat';
    return this.shell?.focused ? (this.shellFocusedPart ?? undefined) : undefined;
  }

  private menuState(): MenuState {
    const selected = this.views?.selected();
    return {
      chat: selected !== undefined,
      liveChat: selected !== undefined && selected.offline === undefined,
      editor: this.editorPane?.hasTabs() === true,
      browser: this.browserEnabled(),
      page: this.browserTabs?.activePage() !== undefined,
      clientCertificateSite: clientCertificateOriginOf(this.browserTabs?.activePage()?.page?.url ?? '') !== undefined,
      focus: this.focusedPart(),
      updateCheck: this.updates !== undefined && canCheck(this.updates.snapshot().state),
      terminalCreate: this.terminals?.canCreate() === true,
      terminal: this.terminals?.target()?.status,
      terminalEditor: this.terminals?.target()?.placement === 'editor',
      terminalTask: this.terminals?.target()?.task === true,
      terminalSplit: this.terminals?.splitActive() === true,
      terminalJoin: this.terminalJoinable(),
      terminalInput: this.terminalInputHasFocus(),
      search: this.searchMenuState(),
      scm: this.scm?.menuState() ?? NO_SCM_MENU_STATE,
      editorKind: this.editorPane?.activeKind(),
      editorDocument: this.editorPane?.activeDocument(),
      editorGit: this.editorPane?.activeGit() ?? null,
      selectedChatHasChanges: this.chatReviews.hasChanges(this.selectedChatKey()),
      ...this.selectedWorktreeMenuState(),
      remoteHostConnected: this.selectedProjectKey !== undefined && this.remoteProject(this.selectedProjectKey) !== undefined && this.authorities?.connection(authorityKeyOfProject(this.selectedProjectKey)) !== undefined,
      remoteHostSaved: (this.hostStore?.hosts().length ?? 0) > 0,
      locatableProject: this.locatable(this.selectedProjectKey),
    };
  }

  // D33's and D61's enablement from the selected chat's last worktree state.
  private selectedWorktreeMenuState(): Pick<MenuState, 'worktree' | 'handOff' | 'newChatInWorktree'> {
    const selected = this.views?.selected();
    const event = selected ? this.worktreeEventOf(selected) : undefined;
    const record = selected && event?.worktreeId !== undefined ? this.worktreeRegistry(selected.authority)?.get(event.worktreeId) : undefined;
    const live = record?.kind === 'chat' && record.deletedAt === undefined ? record : undefined;
    const working = event?.state.phase === 'ready' && event.state.place === 'worktree';
    return {
      worktree: live ? { finish: this.finishStateOf(live), ...(event?.state.baseBranch !== undefined ? { baseBranch: event.state.baseBranch } : {}) } : undefined,
      handOff: event && event.state.phase !== 'deleted' ? { canHandOff: event.state.canHandOff, place: event.state.place } : undefined,
      newChatInWorktree: working ? this.newChatInTarget(live) : undefined,
    };
  }

  // The selected chat's key in main's per-chat maps; undefined while no chat is selected or loaded.
  private selectedChatKey(): string | undefined {
    const selected = this.views?.selected();
    return selected ? this.chatKeyOf(selected) : undefined;
  }

  // EditorService.showChatReview and Chat: Review Changes: the chat's review tab in the editor pane, which shows.
  private async showChatReview(panelId: string, scope: ChatReviewScope): Promise<void> {
    await this.chatReviews.show(panelId, scope);
  }

  // Search's enablement context, from main's search service, editor pane and layout.
  private searchMenuState(): MenuState['search'] {
    const layout = this.windowLayout.sidebar();
    const viewVisible = layout.sidebarVisible && !layout.sections.search.collapsed;
    return this.search?.menuState(viewVisible) ?? { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible };
  }

  private refreshMenuState(): void {
    if (this.platform) updateMenuState(this.menuState());
  }

  // F6 and Shift+F6 move keyboard focus through the sidebar, the editor, the chat and the desktop popups while each is shown,
  // as VS Code's Focus Next Part does; Tab cannot leave a WebContents. A page tab's view is reached through the editor part.
  private focusPart(delta: 1 | -1): void {
    const views = this.views;
    if (!views || !this.shell) return;
    const parts: FocusPart[] = [];
    // the keep-changes banner leads while it counts, so Keep and Revert are one F6 away
    if (this.agentThemes.counting()) parts.push('keepChanges');
    if (this.windowLayout.sidebar().sidebarVisible) parts.push('sidebar');
    if (this.windowLayout.sidebar().grid.visible.editor && this.editorPane?.hasTabs()) parts.push('editor');
    if (views.selected()) parts.push('chat');
    if (this.windowLayout.sidebar().grid.visible.terminal && this.terminals?.hasTerminals()) parts.push('terminal');
    if (this.notifier.showing) parts.push('toasts');
    if (parts.length === 0) return;
    const current = this.focusedPart();
    const index = current === undefined ? (delta === 1 ? -1 : 0) : parts.indexOf(current);
    const next = parts[(index + delta + parts.length) % parts.length]!;
    if (next === 'toasts' && current !== 'toasts') this.toastFocusOrigin = current ?? 'chat';
    if (next === 'keepChanges' && current !== 'keepChanges') this.keepFocus.entered(current ?? 'chat');
    if (current === 'toasts' && next !== 'toasts') this.leavePopupsFor(next);
    else this.focusOn(next);
  }

  // The desktop popups are left out: focus that returns there finds a popup that may be gone.
  private partFocused(part: FocusPart | undefined): void {
    if (part !== undefined && part !== 'toasts') this.lastFocusedPart = part;
  }

  // The screenshot notice names a chat only from this computer's records: its title from main's chat list for a panel showing
  // that session, and a remote chat's host from the host store (docs/invariants.md "Desktop themes").
  private screenshotNoticeNames(origin: string, session: string): ReturnType<AgentThemesDeps['noticeNames']> {
    const panel = this.views?.chats().find((chat) => chat.authority === origin && this.sessionIdOf(chat) === session);
    const chat = (panel ? this.titleOf(panel) : undefined) ?? '';
    if (origin === 'local') return { chat };
    const color = this.hostColor(origin);
    return { chat, host: { name: this.hostName(origin), ...(color !== undefined ? { color } : {}) } };
  }

  // The screenshot notice's time stops while the user may not see it: the window unfocused, minimized, hidden or covered by
  // another app, or an overlay popup or the theme editor dock open over the shell.
  private refreshNoticeHolds(): void {
    const window = this.window;
    const seen = window !== undefined && !window.isDestroyed() && window.isFocused() && !window.isMinimized() && window.isVisible() && this.shellPageVisible;
    this.agentThemes.setNoticeHold('window', !seen);
    this.agentThemes.setNoticeHold('covered', this.overlay?.mode === 'full' || (this.themeDock?.isOpen() === true && !this.themeDock.peeking()));
  }

  // The banner's buttons go with its countdown: focus still on them returns to the part F6 took it from, else to the chat.
  private keepCountdownEnded(): void {
    const part = this.keepFocus.ended(this.focusedPart() === 'keepChanges', 'chat');
    if (part === undefined) return;
    this.shellFocusedPart = null;
    this.focusOn(part);
  }

  // Escape in the popups, or their last card going while they hold focus, gives focus back to the part F6 took it from;
  // popups focused by a click, or left for another window, leave focus where the OS puts it.
  private leavePopups(): void {
    const origin = this.toastFocusOrigin;
    this.toastFocusOrigin = undefined;
    if (origin !== undefined) this.leavePopupsFor(origin);
  }

  // Except on macOS, Electron focuses the window's own page as the window gains focus, and X11 activates the window only
  // after focus() returns; a part focused before that activation lands would lose focus to the shell.
  private leavePopupsFor(part: FocusPart): void {
    this.showWindow();
    if (this.window?.isFocused()) this.focusOn(part);
    else this.focusOnActivation = part;
  }

  // A part that is no longer shown, or an overlay with no popup open, falls back to the selected chat, and with none
  // selected to the window's own page.
  private focusOn(part: FocusPart | 'overlay'): void {
    this.focusOnActivation = undefined;
    const views = this.views;
    if (!views) return;
    if (part === 'overlay' && this.overlay?.mode === 'full') this.overlay.focus();
    else if (part === 'toasts') this.notifier.focusToasts();
    else if (part === 'keepChanges' && this.agentThemes.counting()) this.shell?.focusPart('keepChanges');
    else if (part === 'sidebar' && this.windowLayout.sidebar().sidebarVisible) this.shell?.focusPart('sidebar');
    else if ((part === 'editor' || part === 'terminal') && this.windowLayout.sidebar().grid.visible[part]) this.shell?.focusPart(part);
    else if (views.selected()) views.focusChat();
    else this.window?.webContents.focus();
  }

  // A page or design view that held focus closed or hid; after the editor's republish, so the shell focuses the tab that
  // took its place.
  private focusAwayFromPage(): void {
    setImmediate(() => this.focusOn(this.windowLayout.sidebar().grid.visible.editor && this.editorPane?.hasTabs() ? 'editor' : 'chat'));
  }

  // A refusal of a user's click: a toast, and the shell's invoke rejects with the same text.
  private refuseWithToast(message: string): never {
    void this.notifications.error(message);
    throw new Error(message);
  }

  // Each call that turns a reason on flashes again; the flash stops once no reason is left.
  private flash(reason: 'notifications' | 'overlay', on: boolean): void {
    if (on) this.flashReasons.add(reason);
    else if (!this.flashReasons.delete(reason) || this.flashReasons.size > 0) return;
    if (this.window && !this.window.isDestroyed()) this.window.flashFrame(on);
  }

  private readonly chatTabs: ChatTabMessenger = {
    deliver: (panelId, message) => {
      const views = this.requireViews();
      return this.requireCore().client.deliver(panelId, views.selected()?.panelId, views.chats().map((chat) => chat.panelId), message);
    },
    post: (panelId, message) => {
      this.client()?.post(panelId, message).catch(this.report('Posting to a chat'));
    },
  };

  private installMenu(): void {
    installApplicationMenu(this.orderedLocalFolders(), this.menuActions(), this.requirePlatform().localization, this.menuState());
  }

  // projects.json's folders in the sidebar order, which every list of projects shown to the user follows.
  private orderedLocalFolders(): readonly OpenFolder[] {
    const byKey = new Map(this.projects.folders().map((folder) => [folderKey(folder.fsPath), folder]));
    return (this.hostStore?.order([...byKey.keys()]) ?? [...byKey.keys()]).map((key) => byKey.get(key)!);
  }

  private menuActions(): MenuActions {
    const platform = this.requirePlatform();
    const report = (action: string) => this.report(action);
    return {
      scmRun: (request) => this.scm?.paletteRun(request),
      scmActiveFile: (op) => this.scm?.activeFile(op),
      scmCommit: (variant) => this.scm?.paletteCommit(variant),
      forgeChooseAccount: () => this.scm?.paletteChooseAccount(),
      forgeShowPipeline: () => this.scm?.paletteShowPipeline(),
      forgeOpenAccounts: () => this.openSettings({ section: 'accounts' }),
      forgeOpenCommitOnServer: () => {
        const repoId = this.scm?.paletteRepoId();
        if (repoId !== undefined) this.runForgeLink({ action: 'openCommit', repoId }).catch(report('Open Commit on Server'));
      },
      cloneFromAccount: () => void this.scm?.cloneFromAccount(false).catch(report('Clone from Your Repositories')),
      editorCommand: (command) => this.editorPane?.command(command),
      toggleInlineBlame: () => {
        const settings = this.requirePlatform().settings;
        const shown = settings.get<unknown>(GIT_BLAME_EDITOR_DECORATION_SETTING) !== false;
        settings.update(GIT_BLAME_EDITOR_DECORATION_SETTING, !shown, 'user').catch(report('Toggle Inline Blame'));
      },
      reviewChatChanges: () => {
        const key = this.selectedChatKey();
        if (key !== undefined) this.showChatReview(key, 'chat').catch(report('Review Changes'));
      },
      // core checks again that the chat is idle before it moves anything (D61); the chat's own core moves it
      handOff: (to) => {
        const selected = this.views?.selected();
        const panelId = selected ? this.corePanelIdOf(selected) : undefined;
        if (selected && panelId !== undefined) this.chatHost(selected.authority).run('Hand Off', (core) => core.client.handOff(panelId, to)).catch(report('Hand Off'));
      },
      worktreeFinish: (action: WorktreeFinishAction) => {
        const selected = this.views?.selected();
        const worktreeId = selected ? this.worktreeEventOf(selected)?.worktreeId : undefined;
        if (selected && worktreeId !== undefined) this.worktreesOf(selected.authority).finish(worktreeId, action).catch(report('Worktree'));
      },
      addProject: () => { this.addProject().catch(report('Add Project')); },
      locateProject: () => {
        const key = this.selectedProjectKey;
        if (key !== undefined) void this.locateProject(key);
      },
      newChat: () => { this.newChat(undefined).catch(report('New Chat')); },
      newChatInWorktree: (target) => { this.newChatInWorktree(target).catch(this.newChatInWorktreeFailure()); },
      openChat: () => { this.core.run('Open Chat', (core) => core.client.openChat()).catch(report('Open Chat')); },
      openChatForProject: (fsPath) => { this.newChat(folderKey(fsPath)).catch(report('Open Chat in Project')); },
      newSession: () => { this.core.run('New Session', (core) => core.client.newSession()).catch(report('New Session')); },
      cancelSession: () => { this.core.run('Cancel Session', (core) => core.client.cancelSession()).catch(report('Cancel Session')); },
      quickOpen: () => { this.openQuickOpen('files').catch(report('Quick Open')); },
      showCommands: () => { this.openQuickOpen('commands').catch(report('Command Palette')); },
      searchInFiles: (replace) => this.requireSearch().searchInFiles(replace),
      searchViewCommand: (command) => this.requireSearch().viewCommand(command),
      searchEditorCommand: (command) => this.requireSearch().editorCommand(command),
      cancelSearch: () => this.requireSearch().cancel(),
      clearSearchHistory: () => this.requireSearch().clearSearchHistory(),
      toggleSearchOnType: () => { this.requireSearch().toggleSearchOnType().catch(report('Toggle Search on Type')); },
      newSearchEditor: () => this.requireSearch().newSearchEditor(),
      openSearchEditor: () => this.requireSearch().openSearchEditor(),
      openResultsInEditor: () => this.requireSearch().openResultsInEditor(),
      runChatCommand: (command) => this.runChatCommand(command),
      saveEditor: () => this.editorPane?.command('save'),
      saveEditorAs: () => this.editorPane?.command('saveAs'),
      formatDocument: () => this.editorPane?.command('formatDocument'),
      closeEditor: () => this.editorPane?.command('close'),
      cycleEditor: (delta) => this.editorPane?.cycle(delta),
      relativeByKeyboard: (delta) => {
        if (this.focusedPart() === 'editor' && this.editorPane?.hasTabs()) this.editorPane.cycle(delta);
        else this.selectRelativeChat(delta).catch(report('Select Chat'));
      },
      toggleEditor: () => this.toggleGridPane('editor'),
      toggleTerminal: (byKeyboard) => this.toggleTerminal(byKeyboard),
      newTerminal: () => { this.newTerminal().catch(report('New Terminal')); },
      killTerminal: () => {
        const id = this.terminals?.commandTarget();
        if (id) this.terminals?.requestKill([id]).catch(report('Kill Terminal'));
      },
      restartTerminal: () => {
        const id = this.terminals?.commandTarget();
        if (id) this.terminals?.restart(id).catch(report('Restart Terminal'));
      },
      killAllTerminals: () => {
        const terminals = this.terminals;
        terminals?.requestKill(terminals.ids()).catch(report('Kill All Terminals'));
      },
      runTerminalAction: (action) => this.runTerminalAction(action),
      focusRelativeTerminal: (delta) => this.focusRelativeTerminal(delta),
      splitTerminal: () => {
        const id = this.terminals?.commandTarget();
        if (!id) return;
        this.showTerminalPane();
        this.terminals?.split(id).catch(report('Split Terminal'));
      },
      unsplitTerminal: () => {
        const id = this.terminals?.commandTarget();
        if (id) this.terminals?.unsplit(id);
      },
      joinTerminals: () => {
        const id = this.terminals?.commandTarget();
        if (id) this.joinTerminals(id).catch(report('Join Terminals'));
      },
      focusTerminalPane: (delta) => {
        if (this.terminals?.target()?.placement !== 'panel') return;
        this.showTerminalPane();
        this.terminals.focusPane(delta);
      },
      resizeTerminalPane: (direction) => {
        const id = this.terminals?.commandTarget();
        // VS Code's resizePane does nothing for a group of one pane
        if (id && this.terminals?.splitActive()) this.shell?.runTerminalAction(id, direction === 'left' ? 'resizePaneLeft' : 'resizePaneRight');
      },
      renameTerminal: () => this.renameActiveTerminal(),
      changeTerminalIcon: () => {
        const id = this.terminals?.commandTarget();
        if (id) this.pickTerminalIcon(id).catch(report('Change Icon'));
      },
      changeTerminalColor: () => {
        const id = this.terminals?.commandTarget();
        if (id) this.pickTerminalColor(id).catch(report('Change Color'));
      },
      moveTerminalToEditor: () => {
        const id = this.terminals?.commandTarget();
        if (id) this.terminals?.move({ kind: 'toEditor', id });
      },
      // an editor terminal's detach is Move Terminal into Panel
      moveTerminalToPanel: () => {
        const target = this.terminals?.target();
        if (target?.placement === 'editor') this.terminals?.move({ kind: 'detach', id: target.id });
      },
      selectDefaultTerminalProfile: () => { this.selectDefaultTerminalProfile().catch(report('Select Default Profile')); },
      paste: (matchStyle) => this.paste(matchStyle),
      toggleSidebar: () => this.toggleSidebar(),
      resetTheme: () => { this.themeCommands.reset().catch(this.themeCommands.failed('Reset Theme to Default')); },
      toggleWallpapers: () => { this.toggleWallpapers().catch(this.themeCommands.failed('Toggle Wallpapers')); },
      nextWallpaper: () => { this.nextWallpaper().catch(this.themeCommands.failed('Next Wallpaper')); },
      undoThemeChange: () => { this.themeCommands.undoCommand().catch(this.themeCommands.failed('Undo Theme Change')); },
      restartWithDamoclesTheme: () => this.restartWithDamoclesTheme(),
      openSettings: () => this.openSettings({}),
      selectRelativeChat: (delta) => { this.selectRelativeChat(delta).catch(report('Select Chat')); },
      focusPart: (delta) => this.focusPart(delta),
      togglePromptNavigator: () => {
        if (this.views?.selected()) this.core.run('Toggle Prompt Navigator', (core) => core.client.postToActive({ type: 'togglePromptNavigator' })).catch(report('Toggle Prompt Navigator'));
      },
      newBrowserPage: () => { this.browserTabs?.newPage().catch(report('New Browser Page')); },
      toggleBrowserDevTools: () => this.browserTabs?.activePage()?.deliver({ type: 'openDevTools' }),
      chooseClientCertificate: () => { this.chooseClientCertificate().catch(this.shellFailure('Choose Client Certificate', 'Damocles could not choose a client certificate: {0}')); },
      showLog: () => showLog(),
      // the selected project's host
      restartEngine: () => this.restartEngine(authorityKeyOfProject(this.selectedProjectKey ?? '')),
      remote: {
        connectToHost: () => this.openConnect(undefined),
        disconnectHost: () => this.disconnectSelectedHost(),
        openFolderOnHost: () => { this.openFolderOnHost().catch(this.shellFailure('Open Folder on Host', 'Damocles could not open the Connect dialog: {0}')); },
        forwardPort: () => { this.requirePorts().actions.forward({ projectKey: this.selectedProjectKey }).catch(this.shellFailure('Forward a Port', 'Damocles could not forward the port: {0}')); },
      },
      // a development build's resources folder is Electron's own, never a PATH entry
      ...(app.isPackaged && (CLI_PATH_PLATFORM === 'win32' || CLI_PATH_PLATFORM === 'darwin') ? {
        cliCommand: cliPathActions({
          cliPath: appCliPath(),
          platform: CLI_PATH_PLATFORM,
          t: (message, ...args) => this.requireLocalization().t(message, ...args),
          notice: (severity, message) => { void this.notificationCenter.notice(severity, message, []); },
          log: (line) => log(line),
        }),
      } : {}),
      ...(LOOPBACK ? {
        loopback: {
          openFolder: () => { this.openFolderThroughLocalDaemon().catch(this.shellFailure('Open Folder Through Local Daemon', 'Damocles could not open the folder through the local daemon: {0}')); },
          showLog: () => { this.showLocalDaemonLog().catch(this.shellFailure('Show Local Daemon Log', 'Damocles could not show the local daemon\'s log: {0}')); },
        },
      } : {}),
      about: () => this.openSettings({ section: 'about' }),
      releaseNotes: () => this.openSettings({ section: 'about', release: platform.appInfo.version }),
      checkForUpdates: () => this.requireUpdates().check('help'),
    };
  }

  // What the close's remote question reads and does: every usable connection's chat runs, the setting, the dialog, the
  // keep-running refresh and push, each run's Stop path and the finished-while-away record.
  private closeRemoteDeps(): Parameters<typeof askRemoteRuns>[0] {
    const keepDeps: KeepRunningDeps = {
      resolveCredential: (provider, force) => this.core.run('Refreshing a sign-in for Keep running', (core) => core.client.resolveCredential(provider, force)),
      clientAuth: () => this.core.run('Sign-ins for Keep running', (core) => core.client.clientAuth()),
      log: (line) => log(line),
    };
    return {
      hostRuns: () => this.remoteHostRuns(),
      setting: () => {
        const value = this.platform?.settings.get<unknown>(REMOTE_CLOSE_WITH_RUNNING_AGENTS_SETTING);
        return (isDesktopSettingValue(REMOTE_CLOSE_WITH_RUNNING_AGENTS_SETTING, value) ? value : 'ask') as CloseWithRunningAgents;
      },
      saveSetting: (choice) => writeDesktopSetting(this.requirePlatform().settings, REMOTE_CLOSE_WITH_RUNNING_AGENTS_SETTING, choice),
      row: (host, run) => this.closeRemoteRow(host, run),
      ask: async (rows, onRows) => {
        const request = parseCloseRemoteRequest(rows);
        const overlay = this.overlay;
        // a dialog that cannot show keeps the runs, as an OS shutdown does
        if (!request || !overlay) {
          log(`[close] the remote question cannot show (${request ? 'no overlay' : `${rows.length} rows past its bounds`}); keeping the runs`);
          return { choice: 'keep', dontAskAgain: false };
        }
        this.revealWindow();
        onRows((next) => overlay.updateCloseRemote(next));
        try {
          return closeRemoteResult(await overlay.request(request, webContents.getFocusedWebContents() ?? undefined));
        } catch (err) {
          log(`[close] the remote question did not show (${err instanceof Error ? err.message : String(err)}); keeping the runs`);
          return { choice: 'keep', dontAskAgain: false };
        }
      },
      onStatus: (listener) => {
        this.remoteStatusListeners.add(listener);
        return { dispose: () => { this.remoteStatusListeners.delete(listener); } };
      },
      onHostChanged: (listener) => {
        this.hostNoticeListeners.add(listener);
        return { dispose: () => { this.hostNoticeListeners.delete(listener); } };
      },
      hostFields: (hostId) => this.closeRowHost(hostId),
      startRefresh: (runs) => startKeepRunningRefresh(keepDeps, runs),
      keepAtShutdown: (runs, hosts) => keepRunningAtShutdown(keepDeps, runs, hosts, UNATTENDED_PUSH_MS),
      pushTo: (host): KeepRunningHost => ({
        hostId: host.hostId,
        push: (provider, credential, signal) => this.requireRemoteCore(host.authorityKey).client.pushCredential(provider, credential, signal),
      }),
      stop: (authority, panelId) => this.requireRemoteCore(authority).client.stopChat(panelId),
      leftRunning: (hosts) => Promise.all(hosts.map((host) => this.requireRemoteState().setAway(host.authorityKey, awayChats(host.runs, (panelId) => {
        const view = this.panelOfCore(chatKey(host.authorityKey, panelId));
        return view === undefined ? undefined : this.sessionIdOf(view);
      }), this.remoteCores.get(host.authorityKey)?.epoch() ?? null))).then(() => undefined),
      log: (line) => log(line),
    };
  }

  // Each usable connection's chat runs; a daemon that does not answer listRuns is left out, logged.
  private remoteHostRuns(): Promise<HostRuns[]> {
    const authorities = this.authorities;
    if (!authorities) return Promise.resolve([]);
    return listHostRuns(authorities.connectedKeys().flatMap((authorityKey) => {
      const connection = authorities.connection(authorityKey);
      if (!connection) return [];
      // a daemon that cannot tell this device's runs apart answers the frozen listRuns, every device's runs
      const own = connection.features.includes(LIST_OWN_RUNS_FEATURE);
      return [{
        hostId: this.hostIdOf(authorityKey),
        authorityKey,
        reportsConfigured: own && connection.features.includes(CONFIGURED_PROVIDERS_FEATURE),
        list: async () => {
          if (!own) log(`[close] ${authorityKey} cannot tell this device's runs apart; asking about every run it lists`);
          return (own ? await connection.control.request('listOwnRuns', {}) : await connection.control.request('listRuns', {})).runs;
        },
      }];
    }), (line) => log(line));
  }

  // A close row's host part: its name, safety color and logout warning as this computer knows them now.
  private closeRowHost(hostId: string): CloseRowHost {
    const { name, color } = this.notificationHost(hostId === 'loopback' ? 'loopback' : this.authorityOfHost(hostId));
    const lingerWarning = this.remoteConnections?.notices(hostId).some((notice) => notice.code === 'noLinger') === true;
    return { hostLabel: name, ...(color !== undefined ? { hostColor: color } : {}), ...(lingerWarning ? { lingerWarning: true as const } : {}) };
  }

  // A run's row: its chat's title, its project and host as this computer names them, its status from the chat's activity.
  private closeRemoteRow(host: HostRuns, run: Run): Omit<CloseRemoteRow, 'keyProviders'> {
    const project = this.remoteProjects().find((candidate) => candidate.authorityKey === host.authorityKey && candidate.folderKey === run.projectKey);
    const activity = this.activity.get(chatKey(host.authorityKey, run.id));
    const sessionId = this.clientFor(host.authorityKey)?.chat(run.id)?.sessionId;
    const stored = sessionId === undefined || project === undefined ? undefined : this.catalogRows.get(project.key)?.find((session) => session.id === sessionId);
    return {
      hostId: host.hostId,
      panelId: closeRowId(host.hostId, run.id),
      // the title Chats shows; a chat run's own title names the core's panel, never the conversation
      title: stored ? storedTitle(stored) : '',
      projectLabel: project?.name ?? this.hostName(host.authorityKey),
      ...this.closeRowHost(host.hostId),
      status: activity === undefined ? (run.state === 'waiting' ? 'waiting' : 'running') : closeStatusOf(activity),
    };
  }

  // A remote chat's activity by its session: its Chats row shows another device's run while this window has not loaded it.
  private hostSessionActivity(authority: string, sessionId: string, activity: ChatActivity): void {
    const sessionKey = `${authority}\n${sessionId}`;
    const before = statusOf(this.sessionActivity.get(sessionKey));
    if (statusOf(activity) === 'idle') this.sessionActivity.delete(sessionKey);
    else this.sessionActivity.set(sessionKey, activity);
    if (before === statusOf(activity)) return;
    for (const project of this.remoteProjects()) if (project.authorityKey === authority) this.chatsChanged(project.key);
  }

  private requireRemoteCore(authority: string): RemoteHostedCore {
    const core = this.remoteCores.get(authority)?.host.current();
    if (!core) throw this.notConnected(authority);
    return core;
  }

  // An OS shutdown or an update's quit: the remote runs are kept with no question, their tokens pushed within the window.
  private quitUnattended(why: string): void {
    log(`[close] ${why}: keeping the remote runs without asking`);
    this.closeRelease.keepRunsWithoutAsking();
    app.quit();
  }

  // The quit's graceful Disconnect from each daemon that lists it, after the views detached; the daemon then drops the
  // connection at once instead of holding it for a resume.
  private async disconnectRemotes(): Promise<void> {
    const authorities = this.authorities;
    if (!authorities) return;
    await Promise.all(authorities.connectedKeys().map(async (authorityKey) => {
      const connection = authorities.connection(authorityKey);
      if (!connection?.features.includes(DISCONNECT_FEATURE)) return;
      await connection.control.request('disconnect', {}).catch((err: unknown) => log(`[close] disconnecting from ${authorityKey} failed: ${err instanceof Error ? err.message : String(err)}`));
    }));
  }

  // The extension's deactivate chain (session metadata index close, lease release, sentinels, stores), after the window closed.
  private async disposeAll(): Promise<void> {
    // Before the window closes, so its requests waiting on a reload settle and the window's close is not held up.
    this.core.stop();
    for (const remote of this.remoteCores.values()) remote.host.stop();
    this.views?.retainStatesOnClose(true);
    // ahead of the remotes' disconnect, so a target's --wait gets its answer on the connection
    await this.cliRequests?.dispose();
    // a download's part is removed only by its transfer, and a part sent to a host only while its connection still carries the end
    const transfersStopped = this.fileTransfers?.cancelAll();
    if (transfersStopped) await bounded(transfersStopped, TRANSFER_CANCEL_WAIT_MS, () => log(`[shutdown] the file transfers did not stop within ${TRANSFER_CANCEL_WAIT_MS} ms; quitting anyway`));
    await shutDown({
      // The window's own close handler saves its placement, seals the stores and closes the chats with their states kept.
      closeWindows: () => {
        this.window?.close();
        return this.windowClosed;
      },
      // core's own shutdown waits for its worktree temp folders (git apply must finish), within CLOSE_TIMEOUT_MS; a remote
      // core keeps running in its daemon, which the quit only detaches from
      disposeCore: () => Promise.all([this.core.dispose(), ...[...this.remoteCores.values()].map((remote) => remote.dispose())]).then(() => undefined),
      // The stores last: closing the chats can still change their saved state, and core writes the others.
      flushStores: () => this.flushStores(),
      // a remote host's terminals and its daemon outlive the app: the quit detaches from them
      disposeTerminals: async () => {
        await this.terminals?.dispose();
        await detachRemotes({
          mirrorsIdle: () => Promise.allSettled([...this.sessionMirrors.values()].map((mirror) => mirror.idle())),
          disconnect: () => this.disconnectRemotes(),
          release: () => {
            this.portsView?.dispose();
            this.ports?.dispose();
          },
          waitMs: REMOTE_DETACH_WAIT_MS,
          log: (line) => log(line),
        });
        this.pendingSwitches.dispose();
        this.switchReminders.dispose();
        this.remoteConnections?.dispose();
        this.authorities?.dispose();
        await this.sshAskpass?.dispose();
        await this.terminalAskpass?.dispose();
        await this.exitControlMasters();
      },
      closeWatchers: async () => this.platform?.fileWatchers.close(),
      closeWalks: async () => this.walks?.close(),
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      timeoutMs: DISPOSE_TIMEOUT_MS,
      log: (line) => log(line),
    });
    // every Open in browser URL stops working at quit, and no render window outlives it
    this.designRunner?.closeAll('Damocles is quitting.');
    this.designRenderer?.stop('Damocles is quitting');
    await this.designServer?.dispose();
    this.servedRoots.dispose();
    for (const disposable of this.disposables.reverse()) disposable.dispose();
    this.notificationCenter.dispose();
    this.taskbar.dispose();
    this.notifier.dispose();
    this.tray?.dispose();
    this.tray = undefined;
    this.platform?.settings.dispose();
    await this.launcher?.dispose();
  }

  // Every store under userData, the settings files and every other config file main writes (a settings file editor save);
  // each flush also waits for a write queued while it runs. Core settles its own writes in core.shutdown.
  private async flushStores(): Promise<void> {
    await this.beforeStoreFlush();
    await bounded(this.quitJoins.settled(), QUIT_JOIN_WAIT_MS, () => log(`[shutdown] the work the quit joined did not settle within ${QUIT_JOIN_WAIT_MS} ms; flushing anyway`));
    await Promise.all([
      this.states.flush(),
      this.windowLayout.flush(),
      this.projects.flush(),
      this.trust.flush(),
      this.hostStore?.flush(),
      this.remoteState?.flush(),
      this.usageWarnings.flush(),
      this.themeState.flush(),
      this.state.flush(),
      this.platform?.flush(),
      allJsonConfigWritesSettled(),
      // the quit's last lines, will-quit included, then land in order
      this.logSinks.endAsyncWrites(),
    ]);
  }
}

const CLI_PATH_PLATFORM: NodeJS.Platform = process.platform;
// main's own log, <userData>/logs/Damocles.log
const MAIN_LOG_NAME = 'Damocles';

// The damocles command on PATH: <install>\resources\bin on Windows, Damocles.app/Contents/Resources/bin on macOS.
function appCliPath(): CliPath {
  return createCliPath({
    binDir: path.join(process.resourcesPath, 'bin'),
    userDataDir: app.getPath('userData'),
    ...(process.platform === 'win32' ? { registry: () => windowsRegistry(USER_ENVIRONMENT_KEY), broadcast: broadcastEnvironmentChange } : {}),
    ...(process.platform === 'darwin' ? {
      appBundle: path.resolve(process.resourcesPath, '..', '..'),
      osascript: async (script: string) => {
        const { exit, stderr } = await runProcess({ file: '/usr/bin/osascript', args: ['-e', script], stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: exit?.code ?? null, stderr: stderr.toString('utf8') };
      },
    } : {}),
    log: (line) => log(line),
  });
}

// The installer's `--cli-path add` and the uninstaller's `--cli-path remove`: the PATH entry, then the exit, with no window.
async function runCliPathAction(action: 'add' | 'remove' | 'invalid'): Promise<number> {
  if (action === 'invalid') {
    log('[cli-path] --cli-path takes add or remove');
    return 1;
  }
  if (!app.isPackaged || process.platform !== 'win32') {
    log(`[cli-path] --cli-path ${action} runs only in an installed Windows app`);
    return 1;
  }
  try {
    const cliPath = appCliPath();
    const result = action === 'add' ? await cliPath.add('installer') : await cliPath.remove('installer');
    log(`[cli-path] --cli-path ${action}: ${result}`);
    return 0;
  } catch (err) {
    log(`[cli-path] --cli-path ${action} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  }
}

// Must equal the uninstaller electron-builder's NSIS target writes beside the executable: "Uninstall <productName>.exe".
const WINDOWS_UNINSTALLER = 'Uninstall Damocles.exe';

// The damocles:// scheme: macOS and Linux register it from the package (electron-builder `protocols`), but the NSIS installer
// writes no protocol keys, so the installed Windows app registers itself, with `--` before the link so that no word of a
// link is read as a flag. An unpacked build, a development run and a run with --user-data-dir never register
// (docs/invariants.md "Desktop packaging and updates").
async function registerThemeLinkScheme(): Promise<void> {
  const installed = (): Promise<boolean> => fs.promises.stat(path.join(path.dirname(process.execPath), WINDOWS_UNINSTALLER)).then((stat) => stat.isFile(), () => false);
  if (!(await registersLinkScheme({ platform: process.platform, packaged: app.isPackaged, argv: process.argv, installed }))) return;
  if (!app.setAsDefaultProtocolClient(THEME_LINK_SCHEME, process.execPath, [END_OF_OPTIONS])) log(`[themes] Windows refused to register the ${THEME_LINK_SCHEME}:// scheme`);
}

// Before anything reads a path: the name decides the default userData folder.
app.setName(APP_NAME);
const userDataDir = parseUserDataDir(process.argv);
if (userDataDir !== undefined) app.setPath('userData', path.resolve(userDataDir));
const crashReporterDirectory = parseCrashReporterDirectory(process.argv);
if (crashReporterDirectory !== undefined) {
  // setPath throws for a folder that does not exist; crashpad watches only processes started after start()
  app.setPath('crashDumps', path.resolve(crashReporterDirectory));
  crashReporter.start({ uploadToServer: false });
}
app.setAppUserModelId(APP_ID);
app.enableSandbox();
registerAppScheme();
// Every view sets spellcheck: false, yet on Linux a session still fetches a Hunspell dictionary from Google for each of its
// languages as soon as it exists, so each session is given none as it is created.
app.on('session-created', (created) => {
  created.setSpellCheckerEnabled(false);
  created.setSpellCheckerLanguages([]);
});
// in the design renderer process too, which runs this file
refuseClientCertificates(app);

const cliPathAction = parseCliPathAction(process.argv);
if (isDesignRendererLaunch(process.argv)) {
  // main started this process for core's design renders (D85): no window, no lock, no store of the app's
  runDesignRenderer(process.argv);
} else if (cliPathAction !== undefined) {
  // before the single-instance lock, so a running Damocles neither blocks the installer nor hears this launch
  void withInstallerLog(path.join(app.getPath('userData'), 'logs'), MAIN_LOG_NAME, () => runCliPathAction(cliPathAction)).then((code) => app.exit(code));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // before anything of this launch can create the folder (themes/default-theme.ts)
  const damoclesHomeExisted = homeExisted(DAMOCLES_HOME_DIR);
  // Reading the stores can fail (EACCES on userData), which must end in the same dialog as a failed start.
  const failed = (err: unknown): void => {
    const message = errorText(err);
    log(`[startup] failed: ${message}`);
    dialog.showErrorBox('Damocles failed to start', message);
    app.exit(1);
  };
  try {
    new DesktopApp(damoclesHomeExisted).start().catch(failed);
  } catch (err) {
    failed(err);
  }
}
