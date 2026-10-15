#!/bin/sh
set -eu
# Validate before Caddy expands environment placeholders into its configuration.
export LC_ALL=C
invalid() { printf '%s\n' 'Invalid staging API hostname' >&2; exit 2; }
host=${STAGING_API_HOSTNAME:-}
case "$host" in ''|*[!a-z0-9.-]*|.*|*.|*..*|*[!a-z0-9]) invalid;; esac
[ "${#host}" -le 253 ] || invalid
case "$host" in *.*) ;; *) invalid;; esac
remaining=$host
while [ -n "$remaining" ]; do
  label=${remaining%%.*}
  [ "${#label}" -le 63 ] || invalid
  case "$label" in ''|-*|*-) invalid;; esac
  case "$remaining" in *.*) remaining=${remaining#*.};; *) remaining=;; esac
done
exec "$@"
