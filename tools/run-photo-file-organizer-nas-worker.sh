#!/usr/bin/env bash
# Launch the organizer in a dedicated NAS worker container, independent of the UI container.
set -euo pipefail
umask 077

image=${PHOTO_ORGANIZER_WORKER_IMAGE:-photo-dedup-agent:local}
artifact_root=/volume1/docker/immich/agent/photo-organizer-runs
run_dir=
run_label=perceptual-pilot
resume_run=false
max_workers=${PHOTO_ORGANIZER_MAX_WORKERS:-1}
args=()

while (($# > 0)); do
  case "$1" in
    --artifact-root) artifact_root=$2; shift 2 ;;
    --artifact-root=*) artifact_root=${1#*=}; shift ;;
    --run-label) run_label=$2; shift 2 ;;
    --run-label=*) run_label=${1#*=}; shift ;;
    --run-dir) run_dir=$2; shift 2 ;;
    --run-dir=*) run_dir=${1#*=}; shift ;;
    --resume-run) resume_run=true; shift ;;
    --max-workers) max_workers=$2; shift 2 ;;
    --max-workers=*) max_workers=${1#*=}; shift ;;
    --help|-h) echo 'Use --artifact-root for a new run or --run-dir PATH --resume-run'; exit 0 ;;
    --plan-file|--progress-file|--resume-file|--perceptual) echo "$1 is launcher-owned" >&2; exit 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

[[ "$max_workers" =~ ^[1-9][0-9]*$ ]] || { echo '--max-workers must be a positive integer' >&2; exit 2; }

if [[ $resume_run == true ]]; then
  [[ -n $run_dir && -d $run_dir ]] || { echo 'Resume run directory does not exist' >&2; exit 2; }
  [[ ! -e $run_dir/plan.json ]] || { echo 'Completed plan exists; refusing resume' >&2; exit 2; }
else
  safe_label=$(printf '%s' "$run_label" | tr -cs 'A-Za-z0-9._-' '-'); safe_label=${safe_label#-}; safe_label=${safe_label%-}
  run_dir="$artifact_root/$(date -u +%Y%m%dT%H%M%SZ)-${safe_label}-$$-$RANDOM"
  mkdir -m 0700 -p "$run_dir"
fi

plan_file="$run_dir/plan.json"
progress_file="$run_dir/progress.json"
resume_file="$run_dir/resume.jsonl"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
worker_name="photo-organizer-worker-${run_dir##*/}"
attempt_log="$run_dir/attempt-${stamp}.log"
attempt_command="$run_dir/attempt-${stamp}.command"
touch "$attempt_log" "$attempt_command" "$run_dir/attempt-lifecycle.log"
chmod 0600 "$attempt_log" "$attempt_command" "$run_dir/attempt-lifecycle.log"
printf 'worker_container=%s\nrun_dir=%s\n' "$worker_name" "$run_dir" >"$attempt_command"

if /usr/local/bin/docker ps -a --format '{{.Names}}' | grep -Fxq "$worker_name"; then
  echo "Worker container already exists: $worker_name" >&2
  exit 2
fi
active_workers=$(/usr/local/bin/docker ps --filter label=haus.agent=photo-organizer --format '{{.Names}}' | wc -l | tr -d ' ')
if (( active_workers >= max_workers )); then
  echo "Concurrency guard: $active_workers worker(s) active; max-workers=$max_workers" >&2
  exit 2
fi

/usr/local/bin/docker run -d --name "$worker_name" --restart on-failure:10 \
  --label haus.agent=photo-organizer --label haus.run-dir="$run_dir" --label haus.max-workers="$max_workers" \
  --env ORGANIZER_WORKER_CONTAINER="$worker_name" --env ORGANIZER_WORKER_HOST="synology" \
  -v /volume1:/volume1 -v /volume2:/volume2 -v /volume1/docker/photo-dedup-agent/app:/app "$image" \
  /app/tools/photo-file-organizer-attempt.sh "$run_dir" "$attempt_log" \
  node /app/tools/photo-file-organizer.mjs reconcile-plan --perceptual "${args[@]}" \
  --plan-file "$plan_file" --progress-file "$progress_file" --resume-file "$resume_file" \
  $([[ $resume_run == true ]] && printf '%s' '--resume-run') >"$run_dir/container.id"

printf 'worker=%s\nrun_dir=%s\nprogress=%s\nresume=%s\nlog=%s\nlifecycle=%s\nmax_workers=%s\n' \
  "$worker_name" "$run_dir" "$progress_file" "$resume_file" "$attempt_log" "$run_dir/attempt-lifecycle.log" "$max_workers"
