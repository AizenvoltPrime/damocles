# shellcheck shell=sh
# Stage 1 on a POSIX target: the prerequisite probe, the install and the bridge. Stage 0 evals it from stdin; stdout is the
# app's channel, so every tool writes to stderr and only say() writes to stdout, until the bridge takes stdout over.
# Everything above "BEGIN MAIN" only defines; the tests source that part and call the functions.
# BEGIN PARAMETERS
D_VERSION=''
D_INSTALL_FOLDER=''
D_PREVIOUS_KIND='none'
D_PREVIOUS_FOLDER=''
D_LINUX_X64=''
D_LINUX_ARM64=''
D_ALPINE_X64=''
D_ALPINE_ARM64=''
D_DARWIN_X64=''
D_DARWIN_ARM64=''
# END PARAMETERS

NEEDED_GLIBC='2.28'
NEEDED_KERNEL='4.18'
NEEDED_MACOS='13.5'
NEEDED_MB=300
SUGGESTED_WATCHES=524288
LOCK_STALE_OTHER_HOST_MIN=30
STAGING_STALE_MIN=1440
# an exec test older than this belongs to a stage that died before deleting it
EXEC_TEST_STALE_MIN=1
# a pid file the daemon touched within this long names a live version (it touches it every 24 hours)
LIVE_PID_FILE_MIN=1500
LOCK_WAIT_S=600
UPLOAD_CHUNK=1048576
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

step() {
  say "{\"kind\":\"step\",\"step\":\"$1\"}"
}

# 0 when version $1 >= version $2, compared numerically field by field.
version_at_least() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, ".");
    for (i = 1; i <= (n > m ? n : m); i++) { p = x[i] + 0; q = y[i] + 0; if (p > q) exit 0; if (p < q) exit 1 }
    exit 0 }'
}

free_mb() {
  df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }'
}

file_size() {
  # shellcheck disable=SC2012
  ls -ln "$1" 2>/dev/null | awk '{ print $5 }'
}

check_space() {
  mb=$(free_mb "$1")
  if [ -n "$mb" ] && [ "$mb" -lt "$NEEDED_MB" ]; then
    fail lowSpace "\"folder\":\"$(json_str "$1")\",\"freeMb\":$mb,\"neededMb\":$NEEDED_MB"
  fi
}

expand_home() {
  case "$1" in
    "$tilde") printf '%s' "$HOME" ;;
    "$tilde"/*) printf '%s/%s' "$HOME" "${1#"$tilde"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# $1 as an absolute path with every symbolic link resolved; empty when it is no folder.
canonical() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

# Sets arch to the machine's CPU as a package names it; fails for any other.
set_arch() {
  case "$2" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail unsupportedOs "\"os\":\"$(json_str "$1")\",\"arch\":\"$(json_str "$2")\"" ;;
  esac
}

# NixOS ($1 is its marker file) runs the package's Node and node-pty only through nix-ld, which sets NIX_LD.
check_nixos() {
  if [ -e "$1" ] && [ -z "${NIX_LD:-}" ]; then
    fail nixLdMissing
  fi
}

# glibc when getconf names it, musl when ldd says so or, without either, when the musl loader is in $1; else glibc. A glibc
# host may carry the musl loader too (Debian's musl package).
detect_libc() {
  if [ -n "$(getconf GNU_LIBC_VERSION 2>/dev/null)" ]; then
    printf glibc
  elif ldd --version 2>&1 | grep -qi musl; then
    printf musl
  else
    for loader in "$1"/ld-musl-*.so.1; do
      if [ -e "$loader" ]; then
        printf musl
        return 0
      fi
    done
    printf glibc
  fi
}

# glibc from getconf, else from ldd's first line; fails below NEEDED_GLIBC.
check_glibc() {
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }')
  if [ -z "$glibc" ]; then
    glibc=$(ldd --version 2>&1 | awk 'NR == 1 { print $NF }')
  fi
  if ! version_at_least "$glibc" "$NEEDED_GLIBC"; then
    fail glibcTooOld "\"found\":\"$(json_str "$glibc")\",\"needed\":\"$NEEDED_GLIBC\""
  fi
}

# The first libstdc++.so.6 among $@ must export GLIBCXX_3.4.25.
check_glibcxx() {
  for candidate in "$@"; do
    if [ -e "$candidate" ]; then
      if grep -q 'GLIBCXX_3\.4\.25' "$candidate"; then return 0; fi
      fail glibcxxMissing
    fi
  done
  fail glibcxxMissing
}

check_kernel() {
  kernel=$(printf '%s' "$1" | sed 's/[^0-9.].*//')
  if ! version_at_least "$kernel" "$NEEDED_KERNEL"; then
    fail kernelTooOld "\"found\":\"$(json_str "$kernel")\",\"needed\":\"$NEEDED_KERNEL\""
  fi
}

check_macos() {
  if ! version_at_least "$1" "$NEEDED_MACOS"; then
    fail macosTooOld "\"found\":\"$(json_str "$1")\",\"needed\":\"$NEEDED_MACOS\""
  fi
}

# logind's KillUserProcesses from the files $@, the last assignment winning, as logind reads its drop-ins.
logind_kill_user_processes() {
  cat "$@" 2>/dev/null | sed -n 's/^[[:space:]]*KillUserProcesses[[:space:]]*=[[:space:]]*\([A-Za-z0-9]*\).*/\1/p' | tail -n 1
}

# $1 user, $2 KillUserProcesses, $3 logind's linger folder: agents stop at logout when logind kills and the user has no linger.
check_linger() {
  case "$2" in
    true | yes | 1 | on)
      if [ ! -e "$3/$1" ]; then
        notice noLinger "\"user\":\"$(json_str "$1")\""
      fi
      ;;
  esac
}

check_inotify() {
  if [ -n "$1" ] && [ "$1" -lt "$SUGGESTED_WATCHES" ]; then
    notice lowInotify "\"limit\":$1,\"suggested\":$SUGGESTED_WATCHES"
  fi
}

# <install>: <folder>/<user> for a configured folder, else ~/.damocles/server.
install_dir() {
  if [ -n "$1" ]; then
    printf '%s/%s' "$(expand_home "$1")" "$2"
  else
    printf '%s/.damocles/server' "$HOME"
  fi
}

# Whether a user other than this one and root may change folder $1: group or other write, or another owner.
others_may_write() {
  [ -n "$(find "$1" -maxdepth 0 \( -perm -020 -o -perm -002 -o ! \( -user "$(id -u)" -o -user 0 \) \) 2>/dev/null)" ]
}

# Creates a missing <install> $1 0700, and a missing configured folder $2 above it with the user's umask, since it may be
# shared; refuses an existing <install> in a configured folder others may change (the default is in the user's home, whose
# permissions are the user's). Then runs a two-line script from it: a noexec mount or an execution policy fails here.
prepare_install() {
  if [ ! -d "$1" ]; then
    if [ -n "$2" ]; then
      mkdir -p "$2" >&2 || fail noexec "\"folder\":\"$(json_str "$1")\",\"reason\":\"notWritable\""
    fi
    (umask 077 && mkdir -p "$1") >&2 || fail noexec "\"folder\":\"$(json_str "$1")\",\"reason\":\"notWritable\""
  elif [ -n "$2" ] && others_may_write "$1"; then
    fail installFolderUnsafe "\"folder\":\"$(json_str "$1")\""
  fi
  exec_test=$(mktemp "$1/.exec-test-XXXXXXXX" 2>/dev/null) || fail noexec "\"folder\":\"$(json_str "$1")\",\"reason\":\"notWritable\""
  printf '#!/bin/sh\nexit 0\n' > "$exec_test"
  chmod 700 "$exec_test"
  if ! "$exec_test" >/dev/null 2>&1 </dev/null; then
    rm -f "$exec_test"
    fail noexec "\"folder\":\"$(json_str "$1")\""
  fi
  rm -f "$exec_test"
  check_space "$1"
}

# install.lock is a mkdir lock whose owner file names `<host> <pid>`: stale when that pid is gone on this host, or after
# LOCK_STALE_OTHER_HOST_MIN minutes when another host (a home shared over NFS) took it.
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

# A stale lock is removed only under the takeover lock, so two stages that both judged it stale never remove a lock the other
# has just taken; a takeover lock older than a minute belongs to a stage that died holding it. 1 when the lock is still there.
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

take_lock() {
  waited=0
  until try_lock; do
    waited=$((waited + 1))
    if [ "$waited" -gt "$LOCK_WAIT_S" ]; then
      fail unknown '"reason":"installLocked"'
    fi
    sleep 1
  done
}

release_lock() {
  rm -rf "$lock"
}

remove_old_staging() {
  find "$1" -maxdepth 1 -type d -name '.staging-*' -mmin +"$STAGING_STALE_MIN" -exec rm -rf {} \; 2>/dev/null
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  fi
}

report_progress() {
  have=$(file_size "$1")
  if [ -n "$have" ]; then
    say "{\"progress\":$(awk -v a="$have" -v b="$package_size" 'BEGIN { printf "%.3f", (a > b ? b : a) / b }')}"
  fi
}

# Progress is the staged file's size against the package's, the same for curl and wget.
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$1" "$package_url" >&2 </dev/null &
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$1" "$package_url" >&2 </dev/null &
  else
    return 1
  fi
  fetcher=$!
  while kill -0 "$fetcher" 2>/dev/null; do
    report_progress "$1"
    sleep 1
  done
  wait "$fetcher"
}

# Reads exactly $1 bytes of stdin into $2. Each dd makes one read of at most its block, so nothing past the upload is consumed.
read_exact() {
  left=$1
  part="$2.part"
  : > "$2"
  while [ "$left" -gt 0 ]; do
    chunk=$left
    if [ "$chunk" -gt "$UPLOAD_CHUNK" ]; then chunk=$UPLOAD_CHUNK; fi
    dd bs="$chunk" count=1 of="$part" 2>/dev/null
    got=$(wc -c < "$part" | tr -d ' ')
    if [ "$got" -eq 0 ]; then
      rm -f "$part"
      return 1
    fi
    cat "$part" >> "$2"
    left=$((left - got))
  done
  rm -f "$part"
}

# The app answers an upload request with `<length>\n<bytes>` from its artifact cache.
upload() {
  say '{"kind":"upload"}'
  IFS= read -r length || return 1
  if [ "$length" != "$package_size" ]; then
    return 1
  fi
  read_exact "$length" "$1"
}

# The version an installed version folder holds: a version-named <version>-<target> folder with the package's
# server-package.json; empty for anything else, which no stage or removal touches. remove-posix.sh has the same function.
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

is_version_dir() {
  [ -n "$(version_of_dir "$1")" ]
}

# Whether version folder $1 holds a complete install: the launcher and the package's manifest.
installed() {
  [ -x "$1/bin/damocles-server" ] && [ -f "$1/server-package.json" ]
}

# The versions recently touched pid files name, on this machine or another sharing the home; with $1, only those another
# host wrote, since daemon_runs_from reads this machine's own.
live_versions() {
  for pid_file in "$HOME"/.damocles/server/run-*/daemon.pid; do
    [ -e "$pid_file" ] || continue
    if [ -n "$1" ] && [ "$(sed -n 's/.*"hostname":"\([^"]*\)".*/\1/p' "$pid_file")" = "$(uname -n)" ]; then continue; fi
    if [ -n "$(find "$pid_file" -mmin -"$LIVE_PID_FILE_MIN" 2>/dev/null)" ]; then
      sed -n 's/.*"version":"\([0-9A-Za-z.+-]*\)".*/\1/p' "$pid_file"
    fi
  done
}

# Whether version $1 is among the lines of $2.
listed() {
  printf '%s\n' "$2" | grep -Fqx -- "$1"
}

# Keeps $2 (the current version), every version a live pid file names, and the newest previous one.
prune() {
  keep_versions=$(live_versions '')
  newest_previous=''
  for dir in "$1"/*-*; do
    if ! is_version_dir "$dir" || [ "$dir" = "$2" ]; then continue; fi
    if [ -z "$newest_previous" ] || [ "$dir" -nt "$newest_previous" ]; then newest_previous=$dir; fi
  done
  for dir in "$1"/*-*; do
    if [ "$dir" = "$2" ] || [ "$dir" = "$newest_previous" ]; then continue; fi
    version=$(version_of_dir "$dir")
    if [ -n "$version" ] && ! listed "$version" "$keep_versions"; then rm -rf "$dir"; fi
  done
}

# Whether a live daemon on this machine runs from a program under the canonical folder $1.
daemon_runs_from() {
  [ -n "$1" ] || return 1
  for pid_file in "$HOME"/.damocles/server/run-*/daemon.pid; do
    [ -e "$pid_file" ] || continue
    pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$pid_file")
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then continue; fi
    if [ -e "/proc/$pid/exe" ]; then
      exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
    else
      exe=$(ps -o comm= -p "$pid" 2>/dev/null)
    fi
    case "$exe" in /*) ;; *) continue ;; esac
    case "$(canonical "$(dirname "$exe")")/" in "$1"/*) return 0 ;; esac
  done
  return 1
}

# Removes Damocles' own entries from the previous <install> $1 under its install lock, never the folder itself, which may be
# shared; $2 is the current <install>. Reports settled once nothing of Damocles is left there; a daemon of this machine
# running from it, a live lock, or a version another machine's live pid file names defers that to a later connect.
clean_previous() {
  previous=$(canonical "$1")
  if [ -z "$previous" ] || [ "$previous" = "$(canonical "$2")" ]; then
    say '{"kind":"settled"}'
    return 0
  fi
  if daemon_runs_from "$previous"; then
    return 0
  fi
  lock="$1/install.lock"
  takeover="$1/install.lock.takeover"
  try_lock || return 0
  keep_versions=$(live_versions other)
  kept=''
  for entry in "$1"/*-*; do
    version=$(version_of_dir "$entry")
    [ -n "$version" ] || continue
    if listed "$version" "$keep_versions"; then
      kept=1
    else
      rm -rf "$entry"
    fi
  done
  for entry in "$1"/.staging-*; do
    if [ -e "$entry" ]; then rm -rf "$entry"; fi
  done
  find "$1" -maxdepth 1 -name '.exec-test-*' -mmin +"$EXEC_TEST_STALE_MIN" -exec rm -f {} \; 2>/dev/null
  release_lock
  if [ -n "$(find "$takeover" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$takeover" 2>/dev/null; fi
  if [ -z "$kept" ]; then say '{"kind":"settled"}'; fi
}

# Installs the package into $version_dir under the install lock: downloaded or uploaded into a staging folder, its hash
# checked before it is unpacked, its self-test run, then renamed into place.
install_version() {
  take_lock
  if installed "$version_dir"; then
    release_lock
    return 0
  fi
  step installing
  remove_old_staging "$install"
  staging=$(mktemp -d "$install/.staging-XXXXXXXX") || {
    release_lock
    fail noexec "\"folder\":\"$(json_str "$install")\",\"reason\":\"notWritable\""
  }
  archive="$staging/$package_file"
  if ! download "$archive"; then
    rm -f "$archive"
    if ! upload "$archive"; then
      rm -rf "$staging"
      release_lock
      fail downloadAndUploadFailed
    fi
  fi
  if [ "$(sha256_of "$archive")" != "$package_sha" ]; then
    rm -rf "$staging"
    release_lock
    fail hashMismatch
  fi
  mkdir "$staging/package"
  if ! tar -xzf "$archive" -C "$staging/package" >&2 </dev/null; then
    rm -rf "$staging"
    release_lock
    fail unknown '"reason":"unpackFailed"'
  fi
  rm -f "$archive"
  if ! "$staging/package/bin/damocles-server" self-test >&2 </dev/null; then
    rm -rf "$staging"
    release_lock
    fail selfTestFailed
  fi
  # an incomplete folder of this version, which a failed removal leaves, goes once nothing runs from it
  if [ -e "$version_dir" ] || [ -L "$version_dir" ]; then
    if daemon_runs_from "$(canonical "$version_dir")" || ! rm -rf "$version_dir" || [ -e "$version_dir" ]; then
      rm -rf "$staging"
      release_lock
      fail unknown '"reason":"versionFolderBusy"'
    fi
  fi
  if ! mv "$staging/package" "$version_dir" || ! installed "$version_dir"; then
    rm -rf "$staging"
    release_lock
    fail unknown '"reason":"moveFailed"'
  fi
  rm -rf "$staging"
  prune "$install" "$version_dir"
  release_lock
}

# BEGIN MAIN
step checking

kernel_name=$(uname -s)
machine=$(uname -m)
set_arch "$kernel_name" "$machine"
libc=''
case "$kernel_name" in
  Linux)
    check_nixos /etc/NIXOS
    libc=$(detect_libc /lib)
    if [ "$libc" = musl ]; then
      # Alpine builds libstdc++ without symbol versions; the musl Node needs it installed at all
      if [ ! -e /usr/lib/libstdc++.so.6 ]; then fail glibcxxMissing; fi
    elif [ ! -e /etc/NIXOS ]; then
      check_glibc
      check_glibcxx /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /usr/lib/aarch64-linux-gnu/libstdc++.so.6 /usr/lib64/libstdc++.so.6 /usr/lib/libstdc++.so.6 /lib64/libstdc++.so.6 /lib/libstdc++.so.6
    fi
    check_kernel "$(uname -r)"
    ;;
  Darwin)
    check_macos "$(sw_vers -productVersion 2>/dev/null)"
    ;;
  *) fail unsupportedOs "\"os\":\"$(json_str "$kernel_name")\",\"arch\":\"$(json_str "$machine")\"" ;;
esac

user=$(id -un)
# an empty name would make <folder> itself the install folder
if [ -z "$user" ]; then fail unknown '"reason":"noUserName"'; fi
check_space "$HOME"

if [ "$kernel_name" = Linux ]; then
  kill_user=''
  if command -v busctl >/dev/null 2>&1; then
    kill_user=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null | awk '{ print $2 }')
  fi
  if [ -z "$kill_user" ]; then
    kill_user=$(logind_kill_user_processes /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf)
  fi
  check_linger "$user" "$kill_user" /var/lib/systemd/linger
  check_inotify "$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null)"
fi

case "$kernel_name-$libc" in
  Linux-glibc) target="linux-$arch" ;;
  Linux-musl) target="alpine-$arch" ;;
  *) target="darwin-$arch" ;;
esac
case "$target" in
  linux-x64) package=$D_LINUX_X64 ;;
  linux-arm64) package=$D_LINUX_ARM64 ;;
  alpine-x64) package=$D_ALPINE_X64 ;;
  alpine-arm64) package=$D_ALPINE_ARM64 ;;
  darwin-x64) package=$D_DARWIN_X64 ;;
  *) package=$D_DARWIN_ARM64 ;;
esac
if [ -z "$package" ]; then
  fail unknown "\"reason\":\"noPackage\",\"target\":\"$target\""
fi
# <file> <sha256> <size> <url>, none of which holds a space
package_file=${package%% *}
rest=${package#* }
package_sha=${rest%% *}
rest=${rest#* }
package_size=${rest%% *}
package_url=${rest#* }

install=$(install_dir "$D_INSTALL_FOLDER" "$user")
folder=''
if [ -n "$D_INSTALL_FOLDER" ]; then folder=$(expand_home "$D_INSTALL_FOLDER"); fi
prepare_install "$install" "$folder"
say "{\"kind\":\"probe\",\"target\":\"$target\",\"install\":\"$(json_str "$install")\"}"

version_dir="$install/$D_VERSION-$target"
lock="$install/install.lock"
takeover="$install/install.lock.takeover"

if ! installed "$version_dir"; then
  install_version
fi

case "$D_PREVIOUS_KIND" in
  default) clean_previous "$(install_dir '' "$user")" "$install" ;;
  folder) clean_previous "$(install_dir "$D_PREVIOUS_FOLDER" "$user")" "$install" ;;
esac

step starting
say '{"kind":"bridge"}'
exec "$version_dir/bin/damocles-server" attach
