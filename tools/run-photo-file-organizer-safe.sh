#!/usr/bin/env bash
# Launch a long perceptual organizer plan with a unique run directory and append-only attempt logs.
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
organizer_script=${PHOTO_FILE_ORGANIZER_SCRIPT:-"$script_dir/photo-file-organizer.mjs"}
attempt_runner=${PHOTO_FILE_ORGANIZER_ATTEMPT_RUNNER:-"$script_dir/photo-file-organizer-attempt.sh"}
node_bin=${PHOTO_FILE_ORGANIZER_NODE:-node}
artifact_root=
run_dir=
run_label=perceptual-pilot
resume_run=false
organizer_args=()

usage() {
  cat >&2 <<'EOF'
Usage:
  run-photo-file-organizer-safe.sh --artifact-root PATH [--run-label LABEL] <reconcile-plan arguments>
  run-photo-file-organizer-safe.sh --run-dir PATH --resume-run <same reconcile-plan arguments>

The launcher always runs `reconcile-plan --perceptual` detached. It owns --plan-file,
--progress-file, and --resume-file, placing them in one unique run directory. A resumed
attempt reuses that directory and resume.jsonl but gets a new immutable attempt log.
EOF
}

while (($# > 0)); do
  case "$1" in
    --artifact-root=*)
      artifact_root=${1#*=}
      shift
      ;;
    --artifact-root)
      (($# >= 2)) || { echo "--artifact-root requires a path" >&2; exit 2; }
      artifact_root=$2
      shift 2
      ;;
    --run-dir=*)
      run_dir=${1#*=}
      shift
      ;;
    --run-dir)
      (($# >= 2)) || { echo "--run-dir requires a path" >&2; exit 2; }
      run_dir=$2
      shift 2
      ;;
    --run-label=*)
      run_label=${1#*=}
      shift
      ;;
    --run-label)
      (($# >= 2)) || { echo "--run-label requires a value" >&2; exit 2; }
      run_label=$2
      shift 2
      ;;
    --resume-run)
      resume_run=true
      shift
      ;;
    --plan-file|--progress-file|--resume-file|--perceptual)
      echo "$1 is owned by the safe launcher and must not be passed" >&2
      exit 2
      ;;
    --plan-file=*|--progress-file=*|--resume-file=*|--perceptual=*)
      echo "${1%%=*} is owned by the safe launcher and must not be passed" >&2
      exit 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      organizer_args+=("$1")
      shift
      ;;
  esac
done

if [[ $resume_run == true ]]; then
  [[ -n $run_dir ]] || { echo "--resume-run requires --run-dir" >&2; exit 2; }
  [[ -d $run_dir ]] || { echo "Resume run directory does not exist: $run_dir" >&2; exit 2; }
  [[ ! -e $run_dir/plan.json ]] || {
    echo "Completed plan artifact exists; run is immutable and cannot be resumed: $run_dir/plan.json" >&2
    exit 2
  }
else
  [[ -n $artifact_root ]] || { echo "A new run requires --artifact-root" >&2; exit 2; }
  [[ -z $run_dir ]] || { echo "--run-dir is only valid with --resume-run" >&2; exit 2; }
  safe_label=$(printf '%s' "$run_label" | tr -cs 'A-Za-z0-9._-' '-')
  safe_label=${safe_label#-}
  safe_label=${safe_label%-}
  [[ -n $safe_label ]] || safe_label=perceptual-pilot
  run_dir="$artifact_root/$(date -u +%Y%m%dT%H%M%SZ)-${safe_label}-$$-$RANDOM"
  mkdir -m 0700 -p -- "$artifact_root"
  mkdir -m 0700 -- "$run_dir"
fi

plan_file="$run_dir/plan.json"
progress_file="$run_dir/progress.json"
resume_file="$run_dir/resume.jsonl"
attempt_stamp=$(date -u +%Y%m%dT%H%M%SZ)
attempt_log="$run_dir/attempt-${attempt_stamp}-$$.log"
attempt_command="$run_dir/attempt-${attempt_stamp}-$$.command"

(
  set -o noclobber
  : >"$attempt_log"
  : >"$attempt_command"
)
chmod 0600 "$attempt_log" "$attempt_command"
touch "$run_dir/attempt-lifecycle.log"
chmod 0600 "$run_dir/attempt-lifecycle.log"

command=(
  "$node_bin"
  "$organizer_script"
  reconcile-plan
  --perceptual
  "${organizer_args[@]}"
  --plan-file "$plan_file"
  --progress-file "$progress_file"
  --resume-file "$resume_file"
)
if [[ $resume_run == true ]]; then
  command+=(--resume-run)
fi

{
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'run_dir=%q\n' "$run_dir"
  printf 'command='
  printf '%q ' "${command[@]}"
  printf '\n'
} | tee -a "$attempt_command" >>"$attempt_log"

nohup "$attempt_runner" "$run_dir" "$attempt_log" "${command[@]}" </dev/null >/dev/null 2>&1 &
organizer_pid=$!
printf '%s\n' "$organizer_pid" >"$run_dir/latest.pid"

printf '{\n'
printf '  "status": "launched",\n'
printf '  "pid": %s,\n' "$organizer_pid"
printf '  "runDir": "%s",\n' "$run_dir"
printf '  "planFile": "%s",\n' "$plan_file"
printf '  "progressFile": "%s",\n' "$progress_file"
printf '  "resumeFile": "%s",\n' "$resume_file"
printf '  "attemptLog": "%s",\n' "$attempt_log"
printf '  "lifecycleLog": "%s",\n' "$run_dir/attempt-lifecycle.log"
printf '  "resultFile": "%s"\n' "$run_dir/attempt-result.json"
printf '}\n'
