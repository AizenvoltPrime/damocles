#!/bin/sh
# shellcheck disable=SC2016
# deb postrm and rpm %postun. electron-builder expands the ${...} macros at build time, so shell variables are written as $NAME only.
# rpm runs scriptlets with /bin/sh, so this stays POSIX sh.

# Only a real removal cleans up: an rpm upgrade runs the old %postun (with 1) after the new %post, and a deb upgrade passes "upgrade".
case "$1" in
  remove | purge | 0) ;;
  *) exit 0 ;;
esac

APP_DIR='/opt/${sanitizedProductName}'
EXECUTABLE='${executable}'
PROFILE_TARGET="/etc/apparmor.d/$EXECUTABLE"

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove "$EXECUTABLE" "$APP_DIR/resources/bin/damocles" || echo "Damocles: could not remove the $EXECUTABLE alternative." >&2
fi
# the plain link after-install.sh makes when update-alternatives is missing or fails; a link elsewhere is another program's
if [ -L "/usr/bin/$EXECUTABLE" ]; then
  case $(readlink "/usr/bin/$EXECUTABLE") in
    "$APP_DIR"/*) rm -f "/usr/bin/$EXECUTABLE" ;;
  esac
fi

if [ -f "$PROFILE_TARGET" ]; then
  in_chroot=false
  if [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then in_chroot=true; fi
  if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = "Y" ] && [ "$in_chroot" = false ] && command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser --remove "$PROFILE_TARGET" || echo "Damocles: unloading $PROFILE_TARGET failed; it stays loaded until the next boot." >&2
  fi
  rm -f "$PROFILE_TARGET"
fi

exit 0
