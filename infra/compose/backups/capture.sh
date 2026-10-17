#!/bin/bash
set -Eeuo pipefail
stage=snapshot
trap 'status=$?; printf "BACKUP_STAGE=%s exit=%s\n" "$stage" "$status" >&2' ERR
umask 077
cd /work
set -a
# Operator-owned libpq configuration; never supplied as command arguments.
source /config/source.env
set +a
export PGOPTIONS='-c default_transaction_read_only=on -c row_security=off -c statement_timeout=1200000 -c lock_timeout=10000'
psql=(psql -X -qAt --no-password -v ON_ERROR_STOP=1)
coproc SNAPSHOT { "${psql[@]}"; }
snapshot_pid=$SNAPSHOT_PID
trap 'kill "$snapshot_pid" 2>/dev/null || true' EXIT
printf '%s\n' 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
  "SELECT CASE WHEN rolsuper THEN pg_export_snapshot() ELSE 'DENIED' END FROM pg_roles WHERE rolname=current_user;" >&"${SNAPSHOT[1]}"
read -r snapshot <&"${SNAPSHOT[0]}"
[[ "$snapshot" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]]
# Both readers import the same live snapshot. Source writes may continue.
pg_dump --format=custom --snapshot="$snapshot" --file=database.dump --no-password
{
  printf "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '%s';\n" "$snapshot"
  cat /backup/counts.sql
  printf '\nCOMMIT;\n'
} | "${psql[@]}" > counts.jsonl
"${psql[@]}" -c "SELECT format('CREATE ROLE %I NOLOGIN;', rolname) FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres' ORDER BY rolname;" > verify-roles.sql
# Password-free cluster roles are DR evidence, not automatically applied in rehearsal.
pg_dumpall --roles-only --no-role-passwords --no-password > roles.sql
printf 'ROLLBACK;\n\\q\n' >&"${SNAPSHOT[1]}"
wait "$snapshot_pid"
trap - EXIT
sha256sum database.dump counts.jsonl roles.sql verify-roles.sql > SHA256SUMS
tar -cf bundle.tar database.dump counts.jsonl roles.sql verify-roles.sql SHA256SUMS
stage=encrypt
age -R /config/recipients.txt -o candidate.tar.age bundle.tar
stage=round-trip
age -d -i /config/identity.txt -o roundtrip.tar candidate.tar.age
cmp bundle.tar roundtrip.tar
mkdir restored
tar -xf roundtrip.tar -C restored
(cd restored && sha256sum -c SHA256SUMS)
