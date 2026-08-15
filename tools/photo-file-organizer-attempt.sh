#!/usr/bin/env bash
# Run one organizer attempt while preserving lifecycle evidence beside its log.
set -u
umask 077

run_dir=$1
attempt_log=$2
shift 2
lifecycle_log="$run_dir/attempt-lifecycle.log"
result_file="$run_dir/attempt-result.json"

event() {
  printf '%s event=%s pid=%s ppid=%s code=%s signal=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$$" "$PPID" "${2:-}" "${3:-}" >>"$lifecycle_log"
}

event started
printf '{\n  "status": "running",\n  "pid": %s,\n  "startedAt": "%s",\n  "attemptLog": "%s"\n}\n' \
  "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$attempt_log" >"$result_file"

trap 'event signal 143 TERM; exit 143' TERM
trap 'event signal 130 INT; exit 130' INT
trap 'event signal 129 HUP; exit 129' HUP

set +e
"$@" >>"$attempt_log" 2>&1
exit_code=$?
set -e

event exited "$exit_code"
status=failed
[ "$exit_code" -eq 0 ] && status=completed
printf '{\n  "status": "%s",\n  "pid": %s,\n  "exitCode": %s,\n  "finishedAt": "%s",\n  "attemptLog": "%s"\n}\n' \
  "$status" "$$" "$exit_code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$attempt_log" >"$result_file"
exit "$exit_code"
