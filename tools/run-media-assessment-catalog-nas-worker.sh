#!/usr/bin/env bash
# Launch the rich media assessment catalog in a dedicated NAS worker container.
set -euo pipefail
umask 077

image=${MEDIA_ASSESSMENT_WORKER_IMAGE:-photo-dedup-agent:local}
artifact_root=${MEDIA_ASSESSMENT_ARTIFACT_ROOT:-/volume1/photosync/assistant-catalog/runs}
run_label=media-assessment
max_workers=${MEDIA_ASSESSMENT_MAX_WORKERS:-1}
args=()

while (($# > 0)); do
  case "$1" in
    --artifact-root) artifact_root=$2; shift 2 ;;
    --artifact-root=*) artifact_root=${1#*=}; shift ;;
    --run-label) run_label=$2; shift 2 ;;
    --run-label=*) run_label=${1#*=}; shift ;;
    --max-workers) max_workers=$2; shift 2 ;;
    --max-workers=*) max_workers=${1#*=}; shift ;;
    --database|--progress-file|--summary-file|--run-id)
      echo "$1 is launcher-owned" >&2
      exit 2
      ;;
    --database=*|--progress-file=*|--summary-file=*|--run-id=*)
      echo "${1%%=*} is launcher-owned" >&2
      exit 2
      ;;
    --help|-h)
      echo 'Usage: run-media-assessment-catalog-nas-worker.sh [--run-label LABEL] <media-assessment-catalog run args>' >&2
      exit 0
      ;;
    *) args+=("$1"); shift ;;
  esac
done

[[ "$max_workers" =~ ^[1-9][0-9]*$ ]] || { echo '--max-workers must be a positive integer' >&2; exit 2; }

safe_label=$(printf '%s' "$run_label" | tr -cs 'A-Za-z0-9._-' '-')
safe_label=${safe_label#-}
safe_label=${safe_label%-}
[[ -n "$safe_label" ]] || safe_label=media-assessment
run_dir="$artifact_root/$(date -u +%Y%m%dT%H%M%SZ)-${safe_label}-$$-$RANDOM"
mkdir -m 0700 -p "$run_dir"

run_id=$(basename "$run_dir")
database="$run_dir/media-assessment.sqlite"
progress_file="$run_dir/progress.json"
summary_file="$run_dir/summary.json"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
worker_name="media-assessment-worker-${run_dir##*/}"
attempt_log="$run_dir/attempt-${stamp}.log"
attempt_command="$run_dir/attempt-${stamp}.command"
touch "$attempt_log" "$attempt_command" "$run_dir/attempt-lifecycle.log"
chmod 0600 "$attempt_log" "$attempt_command" "$run_dir/attempt-lifecycle.log"

if /usr/local/bin/docker ps -a --format '{{.Names}}' | grep -Fxq "$worker_name"; then
  echo "Worker container already exists: $worker_name" >&2
  exit 2
fi
active_workers=$(/usr/local/bin/docker ps --filter label=haus.agent=media-assessment --format '{{.Names}}' | wc -l | tr -d ' ')
if (( active_workers >= max_workers )); then
  echo "Concurrency guard: $active_workers media-assessment worker(s) active; max-workers=$max_workers" >&2
  exit 2
fi

command=(
  python3 /app/tools/media-assessment-catalog.py run
  --run-id "$run_id"
  --database "$database"
  --progress-file "$progress_file"
  --summary-file "$summary_file"
  "${args[@]}"
)

{
  printf 'worker_container=%s\nrun_dir=%s\nrun_id=%s\n' "$worker_name" "$run_dir" "$run_id"
  printf 'command='
  printf '%q ' "${command[@]}"
  printf '\n'
} >"$attempt_command"

/usr/local/bin/docker run -d --name "$worker_name" --restart on-failure:10 \
  --label haus.agent=media-assessment --label haus.run-dir="$run_dir" --label haus.max-workers="$max_workers" \
  --env MEDIA_ASSESSMENT_WORKER_CONTAINER="$worker_name" --env MEDIA_ASSESSMENT_WORKER_HOST="synology" \
  -v /volume1:/volume1:ro -v /volume2:/volume2:ro -v "$run_dir":"$run_dir":rw \
  -v /volume1/docker/photo-dedup-agent/app:/app:ro "$image" \
  /app/tools/photo-file-organizer-attempt.sh "$run_dir" "$attempt_log" "${command[@]}" >"$run_dir/container.id"

printf 'worker=%s\nrun_dir=%s\nrun_id=%s\ndatabase=%s\nprogress=%s\nsummary=%s\nlog=%s\nlifecycle=%s\nmax_workers=%s\n' \
  "$worker_name" "$run_dir" "$run_id" "$database" "$progress_file" "$summary_file" "$attempt_log" "$run_dir/attempt-lifecycle.log" "$max_workers"
