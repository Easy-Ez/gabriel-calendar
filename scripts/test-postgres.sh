#!/usr/bin/env bash
set -euo pipefail

for program in initdb pg_ctl createdb; do
  command -v "$program" >/dev/null || { echo "Missing PostgreSQL command: $program" >&2; exit 1; }
done

# A private Unix socket isolates the test cluster from other local processes.
test_root=$(mktemp -d /tmp/gabriel-calendar.XXXXXXXX)
cleanup() {
  pg_ctl -D "$test_root/db" -m immediate stop >/dev/null 2>&1 || true
  rm -rf -- "$test_root"
}
trap cleanup EXIT
mkdir -m 700 "$test_root/socket"
initdb -D "$test_root/db" --auth=trust --username=gabriel_test --no-locale >/dev/null
pg_ctl -D "$test_root/db" -l "$test_root/postgres.log" \
  -o "-c listen_addresses='' -k $test_root/socket" -w start >/dev/null
createdb -h "$test_root/socket" -U gabriel_test gabriel_calendar_test
GABRIEL_TEST_DATABASE_URL="postgresql://gabriel_test@localhost/gabriel_calendar_test?host=$test_root/socket" \
  node --test dist/service/test/*.test.js
