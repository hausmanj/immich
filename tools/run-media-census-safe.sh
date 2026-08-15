#!/bin/sh
# Run a census with an append-only-per-attempt log. Never redirect a census with `>`.
set -eu
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
log_file=${MEDIA_CENSUS_LOG_FILE:-}
args=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-file=*) log_file=${1#*=}; shift ;;
    --log-file)
      [ "$#" -ge 2 ] || { echo "--log-file requires a path" >&2; exit 2; }
      log_file=$2
      shift 2
      ;;
    *) args="$args $(printf '%s' "$1" | sed "s/'/'\\''/g; s/^/'/; s/$/'/")"; shift ;;
  esac
done

if [ -z "$log_file" ]; then
  database=$(printf '%s\n' "$args" | sed -n "s/.*'--database' '\([^']*\)'.*/\1/p")
  if [ -n "$database" ]; then
    log_dir=$(dirname -- "$database")
  else
    log_dir=.
  fi
  log_file="$log_dir/media-census-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
else
  log_dir=$(dirname -- "$log_file")
  base=$(basename -- "$log_file")
  stem=${base%.*}
  suffix=${base##*.}
  [ "$stem" != "$base" ] || suffix=log
  candidate=$log_file
  n=1
  while [ -e "$candidate" ]; do
    candidate="$log_dir/${stem}.attempt${n}.${suffix}"
    n=$((n + 1))
  done
  log_file=$candidate
fi

mkdir -p -- "$log_dir"
printf 'census_log=%s\n' "$log_file"
printf 'census_command=python3 %s%s\n' "$script_dir/media-census.py" "$args"
exec sh -c "exec python3 \"$script_dir/media-census.py\" $args >>\"$log_file\" 2>&1"
