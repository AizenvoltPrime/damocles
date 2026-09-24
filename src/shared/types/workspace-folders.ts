/** A workspace folder a panel can target, as the webview sees it. The webview sends back only `key`. */
export interface WorkspaceFolderInfo {
  key: string;
  name: string;
  /** `name`, plus the shortest parent-path suffix that makes it unique among open folders. */
  label: string;
  path: string;
}
