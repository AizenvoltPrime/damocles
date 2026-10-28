# shellcheck shell=sh
# The removal stage on a POSIX target, run as stage 0 runs stage 1 once the daemon exited: this machine's run folder and the
# socket folders its daemons made, the installed versions no other machine's live daemon names, Damocles' own entries in an
# install folder (never the folder), and, only when asked, the key line Damocles installed and linger. Stdout carries only
# say()'s status lines. Everything above "BEGIN MAIN" only defines; the tests source that part and call the functions.
# BEGIN PARAMETERS
D_RUN_KEY=''
D_INSTALL_FOLDER=''
D_PREVIOUS_FOLDER=''
D_KEY=''
D_KEY_FILE=''
D_DISABLE_LINGER='0'
# END PARAMETERS

# a pid file the daemon touched within this long names a live version (it touches it every 24 hours), as stage 1 reads it
LIVE_PID_FILE_MIN=1500
# lock-timing.ts LOCK_STALE_MS: the daemon refreshes its lock's mtime every 5 s, and a lock older than this has no holder
DAEMON_LOCK_STALE_S=20
# lock-timing.ts TAKEOVER_STALE_MS: a takeover lock older than this was left by a start that died inside it
DAEMON_TAKEOVER_STALE_S=10
LOCK_STALE_OTHER_HOST_MIN=30
STAGING_STALE_MIN=1440
EXEC_TEST_STALE_MIN=1
# where linger.ts looks for loginctl
LOGINCTL_FOLDERS='/bin /usr/bin'
tilde='~'

say() {
  printf '@@DAMOCLES %s\n' "$1"
}

# A JSON string body: control characters dropped, backslash and quote escaped.
json_str() {
  printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

fail() {
  say "{\"kind\":\"fail\",\"code\":\"$1\",\"params\":{${2:-}}}"
  exit 1
}

notice() {
  say "{\"kind\":\"notice\",\"code\":\"$1\",\"params\":{${2:-}}}"
}

expand_home() {
  case "$1" in
    "$tilde") printf '%s' "$HOME" ;;
    "$tilde"/*) printf '%s/%s' "$HOME" "${1#"$tilde"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# <folder>/<user> for a configured install folder
install_dir() {
  printf '%s/%s' "$(expand_home "$1")" "$2"
}

# Deletes $1, reporting it when something of it stays.
delete_entry() {
  rm -rf "$1" >&2
  if [ -e "$1" ] || [ -L "$1" ]; then
    notice deleteFailed "\"entry\":\"$(json_str "$1")\""
  fi
}

# The version an installed version folder holds: a version-named <version>-<target> folder with the package's
# server-package.json; empty for anything else, which no stage or removal touches. stage1-posix.sh has the same function.
version_of_dir() {
  [ -d "$1" ] && [ -f "$1/server-package.json" ] || return 0
  name=$(basename "$1")
  for target in linux-x64 linux-arm64 alpine-x64 alpine-arm64 darwin-x64 darwin-arm64; do
    case "$name" in
      *-"$target")
        version=${name%-"$target"}
        if printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?$'; then printf '%s' "$version"; fi
        return 0
        ;;
    esac
  done
}

# "<version> <hostname>" for each other machine's recently touched pid file; $1 is this machine's run folder.
other_live_daemons() {
  for pid_file in "$HOME"/.damocles/server/run-*/daemon.pid; do
    [ -e "$pid_file" ] || continue
    if [ "$(dirname "$pid_file")" = "$1" ]; then continue; fi
    if [ -n "$(find "$pid_file" -maxdepth 0 -mmin -"$LIVE_PID_FILE_MIN" 2>/dev/null)" ]; then
      version=$(sed -n 's/.*"version":"\([0-9A-Za-z.+-]*\)".*/\1/p' "$pid_file")
      host=$(sed -n 's/.*"hostname":"\([^"]*\)".*/\1/p' "$pid_file")
      if [ -n "$version" ]; then printf '%s %s\n' "$version" "${host:-?}"; fi
    fi
  done
}

# Whether this machine's daemon still runs: its pid file names a live process.
own_daemon_runs() {
  pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$1/daemon.pid" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Seconds since $1 last changed; empty when it cannot be read. GNU and busybox stat take -c, BSD's -f.
seconds_since_change() {
  changed=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)
  if [ -n "$changed" ]; then printf '%s' $(($(date +%s) - changed)); fi
}

# Takes the daemon lock's takeover lock $1 as singleton.ts does, waiting while a start holds it; 1 when it stays held.
enter_daemon_takeover() {
  waited=0
  while ! mkdir "$1" 2>/dev/null; do
    age=$(seconds_since_change "$1")
    if [ -n "$age" ] && [ "$age" -gt "$DAEMON_TAKEOVER_STALE_S" ]; then
      rm -rf "$1"
    elif [ "$waited" -ge "$DAEMON_TAKEOVER_STALE_S" ]; then
      return 1
    else
      sleep 1
      waited=$((waited + 1))
    fi
  done
}

# Whether the daemon lock $1 has no holder: unchanged for DAEMON_LOCK_STALE_S, or its owner file names a process of this host
# that has ended (token.ts goneFromThisHost).
daemon_lock_free() {
  age=$(seconds_since_change "$1")
  if [ -n "$age" ] && [ "$age" -gt "$DAEMON_LOCK_STALE_S" ]; then return 0; fi
  owner=$(cat "$1.owner" 2>/dev/null)
  owner_pid=${owner##* }
  case "$owner_pid" in '' | *[!0-9]*) return 1 ;; esac
  [ "${owner% *}" = "$(uname -n)" ] && ! kill -0 "$owner_pid" 2>/dev/null
}

# Takes the daemon's mkdir lock $1 as singleton.ts does, under its takeover lock and with this stage as its owner, so no
# daemon starts while its run folder goes; 1 while a daemon holds it.
hold_daemon_lock() {
  enter_daemon_takeover "$1.takeover" || return 1
  if mkdir "$1" 2>/dev/null || { daemon_lock_free "$1" && rm -rf "$1" && mkdir "$1" 2>/dev/null; }; then
    printf '%s %s\n' "$(uname -n)" "$$" > "$1.owner"
    rmdir "$1.takeover"
    return 0
  fi
  rmdir "$1.takeover"
  return 1
}

release_daemon_lock() {
  rm -f "$1.owner"
  rmdir "$1"
}

# The daemon's lock $1 this stage holds, touched as the daemon touches its own, so a starting daemon never takes it as stale.
refresh_daemon_lock() {
  touch -c "$1"
}

# A socket folder a daemon made: a damocles-* folder of this user's, emptied of the names a daemon makes in one, then removed.
remove_socket_folder() {
  case "$(basename "$1")" in damocles-*) ;; *) return 0 ;; esac
  if [ -L "$1" ] || [ ! -d "$1" ] || [ -z "$(find "$1" -maxdepth 0 -user "$(id -u)" 2>/dev/null)" ]; then return 0; fi
  rm -f "$1/daemon.sock" "$1/token" "$1/askpass.sock" "$1"/agent-*.sock
  if ! rmdir "$1" 2>/dev/null; then
    notice deleteFailed "\"entry\":\"$(json_str "$1")\""
  fi
}

# Every socket folder the run folder $1 records: the pid file's endpoint folder and the daemon's socket-folders list, which
# names a crashed daemon's agent and relay folders too. The lock is touched after each.
remove_socket_folders() {
  endpoint_folder=$(sed -n 's/.*"socketFolder":"\([^"]*\)".*/\1/p' "$1/daemon.pid" 2>/dev/null)
  if [ -n "$endpoint_folder" ]; then
    remove_socket_folder "$endpoint_folder"
    refresh_daemon_lock "$1/daemon.lock"
  fi
  if [ -f "$1/socket-folders" ]; then
    while IFS= read -r socket_folder; do
      case "$socket_folder" in /*) remove_socket_folder "$socket_folder" ;; esac
      refresh_daemon_lock "$1/daemon.lock"
    done < "$1/socket-folders"
  fi
}

# Deletes the run folder $1, whose daemon lock this stage holds: every entry but the lock, its owner file and a start's
# takeover lock, the lock touched after each, then the lock, then the folder, which a start's takeover lock keeps.
remove_run_dir() {
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
    case "$entry" in
      "$1/daemon.lock" | "$1/daemon.lock.owner" | "$1/daemon.lock.takeover") ;;
      *)
        delete_entry "$entry"
        refresh_daemon_lock "$1/daemon.lock"
        ;;
    esac
  done
  rm -f "$1/daemon.lock.owner"
  refresh_daemon_lock "$1/daemon.lock"
  rmdir "$1/daemon.lock"
  rmdir "$1"
}

# install.lock as stage 1 takes it: a mkdir lock whose owner file names `<host> <pid>`, stale when that pid is gone on this
# host or after LOCK_STALE_OTHER_HOST_MIN minutes when another host took it, removed only under the takeover lock.
lock_is_stale() {
  owner=$(cat "$lock/owner" 2>/dev/null)
  owner_host=${owner% *}
  owner_pid=${owner##* }
  if [ -n "$owner" ] && [ "$owner_host" = "$(uname -n)" ]; then
    ! kill -0 "$owner_pid" 2>/dev/null
  else
    [ -n "$(find "$lock" -maxdepth 0 -mmin +"$LOCK_STALE_OTHER_HOST_MIN" 2>/dev/null)" ]
  fi
}

remove_stale_lock() {
  if [ -n "$(find "$takeover" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    rmdir "$takeover" 2>/dev/null
  fi
  if mkdir "$takeover" 2>/dev/null; then
    if lock_is_stale; then
      rm -rf "$lock"
    fi
    rmdir "$takeover"
    [ ! -e "$lock" ]
    return
  fi
  return 1
}

# Takes $lock at once, taking over a stale one; 1 while a live stage holds it.
try_lock() {
  if ! mkdir "$lock" 2>/dev/null; then
    if ! lock_is_stale || ! remove_stale_lock || ! mkdir "$lock" 2>/dev/null; then return 1; fi
  fi
  printf '%s %s\n' "$(uname -n)" "$$" > "$lock/owner"
}

# Under folder $1's install lock, removes the version folders no other live daemon names, then the staging folders, the exec
# tests and the lock; $2 lists "<version> <hostname>" lines of the other live daemons. A stage installing there keeps the
# folder as it is, and only staging folders and exec tests too old to be in use go.
remove_entries() {
  [ -d "$1" ] || return 0
  lock="$1/install.lock"
  takeover="$1/install.lock.takeover"
  if ! try_lock; then
    notice installInProgress "\"folder\":\"$(json_str "$1")\""
    find "$1" -maxdepth 1 -type d -name '.staging-*' -mmin +"$STAGING_STALE_MIN" -exec rm -rf {} \; 2>/dev/null
    find "$1" -maxdepth 1 -name '.exec-test-*' -mmin +"$EXEC_TEST_STALE_MIN" -exec rm -f {} \; 2>/dev/null
    return 0
  fi
  for dir in "$1"/*-*; do
    version=$(version_of_dir "$dir")
    [ -n "$version" ] || continue
    machine=$(printf '%s\n' "$2" | awk -v v="$version" '$1 == v { print $2; exit }')
    if [ -n "$machine" ]; then
      notice versionKept "\"version\":\"$(json_str "$version")\",\"machine\":\"$(json_str "$machine")\""
      continue
    fi
    delete_entry "$dir"
  done
  for entry in "$1"/.staging-*; do
    if [ -e "$entry" ]; then delete_entry "$entry"; fi
  done
  find "$1" -maxdepth 1 -name '.exec-test-*' -mmin +"$EXEC_TEST_STALE_MIN" -exec rm -f {} \; 2>/dev/null
  rm -rf "$lock"
  if [ -n "$(find "$takeover" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$takeover" 2>/dev/null; fi
}

# Deletes the lines of $2 that hold the key $1 (type and blob), keeping the file, its mode and its owner. A file that cannot
# be read or rewritten fails with keyFile; the kept lines stay beside it when the rewrite failed.
remove_key() {
  if [ ! -f "$2" ]; then
    notice keyNotFound
    return 0
  fi
  status=0
  grep -q -F -- "$1" "$2" || status=$?
  if [ "$status" -eq 1 ]; then
    notice keyNotFound
    return 0
  fi
  if [ "$status" -ne 0 ]; then fail stageFailed '"code":"keyFile"'; fi
  kept=$(mktemp "$(dirname "$2")/.damocles-keys-XXXXXXXX") || fail stageFailed '"code":"keyFile"'
  status=0
  grep -v -F -- "$1" "$2" > "$kept" || status=$?
  if [ "$status" -gt 1 ]; then
    rm -f "$kept"
    fail stageFailed '"code":"keyFile"'
  fi
  if ! cat "$kept" > "$2"; then
    fail stageFailed '"code":"keyFile"'
  fi
  rm -f "$kept"
}

# loginctl at the absolute path linger.ts uses: the first of LOGINCTL_FOLDERS holding it; empty when none does.
loginctl_path() {
  for folder in $LOGINCTL_FOLDERS; do
    if [ -x "$folder/loginctl" ]; then
      printf '%s' "$folder/loginctl"
      return 0
    fi
  done
}

# BEGIN MAIN
case "$D_RUN_KEY" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) fail stageFailed '"code":"runKey"' ;;
esac
user=$(id -un)
# an empty name would make <folder> itself the install folder
if [ -z "$user" ]; then fail stageFailed '"code":"userName"'; fi
server="$HOME/.damocles/server"
run_dir="$server/run-$D_RUN_KEY"
if [ -d "$run_dir" ]; then
  if ! hold_daemon_lock "$run_dir/daemon.lock"; then
    fail daemonRunning
  fi
  if own_daemon_runs "$run_dir"; then
    release_daemon_lock "$run_dir/daemon.lock"
    fail daemonRunning
  fi
fi
others=$(other_live_daemons "$run_dir")

if [ -d "$run_dir" ]; then
  remove_socket_folders "$run_dir"
  remove_run_dir "$run_dir"
fi
remove_entries "$server" "$others"
for folder in "$D_INSTALL_FOLDER" "$D_PREVIOUS_FOLDER"; do
  if [ -n "$folder" ]; then
    install=$(install_dir "$folder" "$user")
    remove_entries "$install" "$others"
    # <folder>/<user> goes once empty; <folder> itself always stays
    rmdir "$install" 2>/dev/null || true
  fi
done
if ! rmdir "$server" 2>/dev/null && [ -d "$server" ]; then
  notice serverFolderKept
fi

if [ -n "$D_KEY" ]; then
  remove_key "$D_KEY" "$D_KEY_FILE"
fi
if [ "$D_DISABLE_LINGER" = 1 ]; then
  loginctl=$(loginctl_path)
  if [ -z "$loginctl" ] || ! "$loginctl" --no-ask-password disable-linger "$user" >&2 </dev/null; then
    notice lingerFailed
  fi
fi
say '{"kind":"removed"}'
