#!/bin/sh
set -eu
umask 077

# This is an internal implementation detail of osm update/uninstall. Load the
# operation as a function before replacing/removing the file that contains it.
main() {
  install_root='/Library/Application Support/OpenSaysMe'
  command_directory=/usr/local/bin
  temporary=
  operation_owned=0
  operation_uncertain=0
  fail() { printf '%s\n' "OpenSaysMe: $*" >&2; exit 1; }
  cleanup() {
    if [ -n "$temporary" ]; then /bin/rm -rf "$temporary"; fi
    if [ "$operation_owned" = 1 ] && [ "$operation_uncertain" = 0 ] && [ -d "$install_root/.operation" ]; then
      /bin/rm -f "$install_root/.operation/pid" "$install_root/.operation/started" "$install_root/.operation/action"
      /bin/rmdir "$install_root/.operation" || true
    fi
  }
  trap cleanup EXIT
  trap 'operation_uncertain=1; exit 1' HUP INT TERM

  [ "$(/usr/bin/id -u)" = 0 ] || fail 'Administrator authorization is required.'
  for path in /Library '/Library/Application Support' "$install_root" "$install_root/manage.sh" "$install_root/.opensaysme-package"; do
    [ -e "$path" ] && [ ! -L "$path" ] || fail 'The package installation is missing or unsafe.'
    [ "$(/usr/bin/stat -f '%u' "$path")" = 0 ] || fail 'The package installation must be owned by root.'
    permissions=$(/usr/bin/stat -f '%Lp' "$path")
    [ "$((0$permissions & 022))" = 0 ] || fail 'The package installation has unsafe permissions.'
  done
  [ -d "$install_root" ] && [ -f "$install_root/manage.sh" ] && [ -f "$install_root/.opensaysme-package" ] || fail 'Invalid package installation.'
  printf 'dev.opensaysme.cli\n' | /usr/bin/cmp -s - "$install_root/.opensaysme-package" || fail 'Unrecognized package installation.'
  case "${1:-}" in uninstall|update) ;; *) fail 'Invalid package operation.' ;; esac
  /bin/mkdir "$install_root/.operation" || fail 'Another package operation is active. Wait for Installer or reinstall the package to recover an interrupted operation.'
  operation_owned=1
  printf '%s\n' "$$" > "$install_root/.operation/pid"
  LC_ALL=C /bin/ps -p "$$" -o lstart= > "$install_root/.operation/started"
  printf '%s\n' "$1" > "$install_root/.operation/action"

  case "${1:-}" in
    uninstall)
      [ "$#" = 1 ] || fail 'Invalid removal request.'
      processes=$(/bin/ps -axo comm=) || fail 'Cannot check whether OpenSaysMe is running. Close it and retry.'
      helper="$install_root/OpenSaysMe.bundle/Contents/Resources/native/macos/bin/opensaysme-desktop"
      if printf '%s\n' "$processes" | /usr/bin/awk -v helper="$helper" \
        '{ sub(/^[[:space:]]+/, ""); if ($0 == helper) found = 1 } END { exit !found }'; then
        fail 'Close OpenSaysMe in all logged-in sessions and retry the removal.'
      fi
      for path in /usr /usr/local "$command_directory"; do
        [ ! -L "$path" ] || fail 'Cannot remove commands through a symbolic link.'
        if [ -e "$path" ]; then [ -d "$path" ] || fail 'Invalid command directory.'; fi
      done
      if [ -d "$command_directory" ]; then
        # Anchor removals to one directory even if a user-owned ancestor moves.
        (
          cd -P "$command_directory"
          for name in osm opensaysme; do
            if [ -L "./$name" ] && [ "$(/usr/bin/readlink "./$name")" = "$install_root/bin/osm" ]; then
              /bin/rm "./$name"
            fi
          done
        )
      fi
      /bin/rm -rf "$install_root"
      if /usr/sbin/pkgutil --pkg-info dev.opensaysme.cli >/dev/null 2>&1; then
        /usr/sbin/pkgutil --forget dev.opensaysme.cli
      fi
      ;;
    update)
      [ "$#" = 3 ] || fail 'Invalid update request.'
      case "$2" in /*) ;; *) fail 'Invalid update file.' ;; esac
      [ -f "$2" ] && [ ! -L "$2" ] || fail 'The downloaded package is missing or unsafe.'
      [ "${#3}" = 64 ] || fail 'Invalid package checksum.'
      case "$3" in *[!a-f0-9]*) fail 'Invalid package checksum.' ;; esac
      temporary=$(/usr/bin/mktemp -d /private/tmp/opensaysme-installer.XXXXXX)
      /bin/cp "$2" "$temporary/update.pkg"
      /bin/chmod 600 "$temporary/update.pkg"
      # Verify the root-owned copy, so changes to the download cannot race the
      # privileged Installer invocation.
      actual=$(/usr/bin/shasum -a 256 "$temporary/update.pkg")
      [ "${actual%% *}" = "$3" ] || fail 'The downloaded package checksum does not match.'
      operation_uncertain=1
      /usr/sbin/installer -pkg "$temporary/update.pkg" -target /
      operation_uncertain=0
      ;;
    *) fail 'Invalid package operation.' ;;
  esac
}

main "$@"
