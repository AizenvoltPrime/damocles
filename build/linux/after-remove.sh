#!/bin/sh
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
  update-alternatives --remove "$EXECUTABLE" "$APP_DIR/$EXECUTABLE" || echo "Damocles: could not remove the $EXECUTABLE alternative." >&2
else
  rm -f "/usr/bin/$EXECUTABLE"
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
