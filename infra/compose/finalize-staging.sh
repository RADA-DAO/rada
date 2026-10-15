#!/bin/sh
# Invoke only after the matching Worker revision has published successfully.
set -eu
case "${1:-}" in *[!0-9a-f]*|'') exit 2;; esac
[ "${#1}" -eq 40 ] || exit 2
release_root=/srv/rada-staging
[ "$(cat "$release_root/api-pending-sha")" = "$1" ] || exit 2
umask 077
printf '%s\n' "$1" > "$release_root/current-sha.tmp"
mv "$release_root/current-sha.tmp" "$release_root/current-sha"
rm "$release_root/api-pending-sha"
