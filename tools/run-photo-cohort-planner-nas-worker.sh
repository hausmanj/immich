#!/usr/bin/env bash
# Launch Stage 3 cohort planning in a dedicated, restartable, read-only NAS worker.
set -euo pipefail
umask 077

image=${PHOTO_COHORT_WORKER_IMAGE:-photo-dedup-agent:local}
artifact_root=/volume1/docker/immich/agent/photo-cohort-runs
run_dir=
run_label=stage3-cohorts
dedupe_plan=
resume_run=false

while (($# > 0)); do
  case "$1" in
    --artifact-root) artifact_root=$2; shift 2 ;;
    --artifact-root=*) artifact_root=${1#*=}; shift ;;
    --run-label) run_label=$2; shift 2 ;;
    --run-label=*) run_label=${1#*=}; shift ;;
    --run-dir) run_dir=$2; shift 2 ;;
    --run-dir=*) run_dir=${1#*=}; shift ;;
    --dedupe-plan) dedupe_plan=$2; shift 2 ;;
    --dedupe-plan=*) dedupe_plan=${1#*=}; shift ;;
    --resume-run) resume_run=true; shift ;;
    --help|-h)
      echo 'Use --dedupe-plan PATH for a new run or --run-dir PATH --dedupe-plan PATH --resume-run'
      exit 0
      ;;
    --plan-file|--progress-file|--resume-file)
      echo "$1 is launcher-owned" >&2
      exit 2
      ;;
    *)
      echo "Unexpected argument: $1" >&2
      exit 2
      ;;
  esac
done

[[ -n $dedupe_plan && -f $dedupe_plan ]] || { echo 'A completed --dedupe-plan file is required' >&2; exit 2; }

if [[ $resume_run == true ]]; then
  [[ -n $run_dir && -d $run_dir ]] || { echo 'Resume run directory does not exist' >&2; exit 2; }
  [[ ! -e $run_dir/cohort-plan.json ]] || { echo 'Completed cohort plan exists; refusing resume' >&2; exit 2; }
else
  safe_label=$(printf '%s' "$run_label" | tr -cs 'A-Za-z0-9._-' '-')
  safe_label=${safe_label#-}
  safe_label=${safe_label%-}
  run_dir="$artifact_root/$(date -u +%Y%m%dT%H%M%SZ)-${safe_label}-$$-$RANDOM"
  mkdir -m 0700 -p "$run_dir"
fi

plan_file="$run_dir/cohort-plan.json"
progress_file="$run_dir/progress.json"
resume_file="$run_dir/metadata-resume.jsonl"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
worker_name="photo-cohort-worker-${run_dir##*/}"
attempt_log="$run_dir/attempt-${stamp}.log"
attempt_command="$run_dir/attempt-${stamp}.command"
touch "$attempt_log" "$attempt_command" "$run_dir/attempt-lifecycle.log"
chmod 0600 "$attempt_log" "$attempt_command" "$run_dir/attempt-lifecycle.log"
printf 'worker_container=%s\nrun_dir=%s\ndedupe_plan=%s\n' \
  "$worker_name" "$run_dir" "$dedupe_plan" >"$attempt_command"

if /usr/local/bin/docker ps -a --format '{{.Names}}' | grep -Fxq "$worker_name"; then
  echo "Worker container already exists: $worker_name" >&2
  exit 2
fi

# The namespace is mounted read-only. Only this run directory is over-mounted read-write.
# --resume-run is always passed so an automatic Docker restart reuses the same metadata ledger.
/usr/local/bin/docker run -d --name "$worker_name" --restart on-failure:10 --stop-timeout 30 \
  --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --label haus.agent=photo-cohort-planner --label haus.run-dir="$run_dir" \
  -v /volume1:/volume1:ro -v /volume2:/volume2:ro -v "$run_dir":"$run_dir":rw \
  -v /volume1/docker/photo-dedup-agent/app:/app:ro "$image" \
  /app/tools/photo-file-organizer-attempt.sh "$run_dir" "$attempt_log" \
  node /app/tools/photo-cohort-planner.mjs plan \
  --dedupe-plan "$dedupe_plan" \
  --plan-file "$plan_file" \
  --progress-file "$progress_file" \
  --resume-file "$resume_file" \
  --resume-run >"$run_dir/container.id"

printf 'worker=%s\nrun_dir=%s\nplan=%s\nprogress=%s\nresume=%s\nlog=%s\nlifecycle=%s\n' \
  "$worker_name" "$run_dir" "$plan_file" "$progress_file" "$resume_file" \
  "$attempt_log" "$run_dir/attempt-lifecycle.log"
