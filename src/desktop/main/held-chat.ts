// chats.showSession: a daemon's core revealed a chat as this device's work. The daemon named a chat its core holds, so the
// view joins that panel by the stored session (views.join) and never looks the chat up in this device's chat lists, which
// hold only the projects this device opened and the files their catalog has listed so far.

export interface HeldChatDeps<V> {
  // a view of this device already showing the chat
  readonly loaded: () => V | undefined;
  // a new chat view of the authority, onto the stored session, tracked under a project and not shown yet
  readonly create: () => V;
  // the view joins the core's panel holding the session; false when no panel of the core holds it
  readonly join: (view: V) => Promise<boolean>;
  readonly show: (view: V) => void;
  readonly dispose: (view: V) => void;
}

/** Shows the chat, opening a view of it when this device shows none; false when it did not open. */
export async function showHeldChat<V>(deps: HeldChatDeps<V>): Promise<boolean> {
  const loaded = deps.loaded();
  if (loaded !== undefined) {
    deps.show(loaded);
    return true;
  }
  const view = deps.create();
  let joined = false;
  try {
    joined = await deps.join(view);
  } finally {
    if (!joined) deps.dispose(view);
  }
  if (joined) deps.show(view);
  return joined;
}
