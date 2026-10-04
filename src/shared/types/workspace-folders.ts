/** A workspace folder a panel can target, as the webview sees it. The webview sends back only `key`. */
export interface WorkspaceFolderInfo {
  key: string;
  name: string;
  /** `name`, plus the shortest parent-path suffix that makes it unique among open folders. */
  label: string;
  path: string;
  /** The branch checked out in the folder, or a detached HEAD's short id; absent outside git (D42). */
  branch?: string;
}
