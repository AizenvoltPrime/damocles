#!/bin/sh
# deb postinst and rpm %post. electron-builder expands the ${...} macros at build time, so shell variables are written as $NAME only.
# rpm runs scriptlets with /bin/sh, so this stays POSIX sh.

APP_DIR='/opt/${sanitizedProductName}'
EXECUTABLE='${executable}'
PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
PROFILE_TARGET="/etc/apparmor.d/$EXECUTABLE"

if command -v update-alternatives >/dev/null 2>&1; then
  if [ -L "/usr/bin/$EXECUTABLE" ] && [ -e "/usr/bin/$EXECUTABLE" ] && [ "$(readlink "/usr/bin/$EXECUTABLE")" != "/etc/alternatives/$EXECUTABLE" ]; then
    rm -f "/usr/bin/$EXECUTABLE"
  fi
  update-alternatives --install "/usr/bin/$EXECUTABLE" "$EXECUTABLE" "$APP_DIR/$EXECUTABLE" 100 || ln -sf "$APP_DIR/$EXECUTABLE" "/usr/bin/$EXECUTABLE"
else
  ln -sf "$APP_DIR/$EXECUTABLE" "/usr/bin/$EXECUTABLE"
fi

# The setuid helper is the Chromium sandbox wherever unprivileged user namespaces are unavailable; the app never runs with --no-sandbox.
# root can unshare even where the kernel denies unprivileged user namespaces, so the two sysctls that deny them are read too.
if [ -L /proc/self/ns/user ] && unshare --user true >/dev/null 2>&1 \
  && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" != "0" ] \
  && [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" != "0" ]; then
  SANDBOX_MODE=0755
else
  SANDBOX_MODE=4755
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || echo "Damocles: update-mime-database failed; file type icons refresh at the next database update." >&2
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || echo "Damocles: update-desktop-database failed; the menu entry appears at the next database update." >&2
fi

# AppArmor is optional: without it (Fedora, Debian with AppArmor removed) nothing is installed and the install succeeds.
PROFILE_LOADED=false
if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
  # AppArmor before 4.0 (Ubuntu 22.04) cannot parse the abi 4.0 profile and does not restrict user namespaces, so it needs none.
  if apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" >/dev/null 2>&1; then
    cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET" && chmod 0644 "$PROFILE_TARGET" || echo "Damocles: could not write $PROFILE_TARGET." >&2
    in_chroot=false
    if [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then in_chroot=true; fi
    if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = "Y" ] && [ "$in_chroot" = false ] && [ -f "$PROFILE_TARGET" ]; then
      if apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE_TARGET"; then
        PROFILE_LOADED=true
      else
        echo "Damocles: loading $PROFILE_TARGET failed; the app uses the setuid sandbox until the profile loads." >&2
      fi
    fi
  else
    echo "Damocles: this AppArmor version does not support the bundled abi 4.0 profile; skipping it." >&2
  fi
fi

# Where AppArmor restricts unprivileged user namespaces, only the loaded profile lets Chromium create them.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] && [ "$PROFILE_LOADED" = false ]; then
  SANDBOX_MODE=4755
fi
chmod "$SANDBOX_MODE" "$APP_DIR/chrome-sandbox" || exit 1

exit 0
