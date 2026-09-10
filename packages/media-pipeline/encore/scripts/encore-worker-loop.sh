#!/bin/sh
# Keep SVT encore-worker alive under Compose.
# Official worker polls one job (or drains the queue) then exits — see
# https://svt.github.io/encore/deployment/ — so a bare `restart: unless-stopped`
# busy-loops when idle. This wrapper sleeps between exits instead.
set -eu

BIN="${ENCORE_WORKER_BIN:-/app/encore-worker}"
IDLE_SLEEP="${ENCORE_WORKER_IDLE_SLEEP_S:-5}"

# Drain remaining queued work before exit (default). Override to false for
# KEDA-style single-job pods.
export ENCORE_SETTINGS_WORKER_DRAIN_QUEUE="${ENCORE_SETTINGS_WORKER_DRAIN_QUEUE:-true}"

echo "encore-worker-loop: starting ${BIN} (idle sleep ${IDLE_SLEEP}s)" >&2

while true; do
  set +e
  "${BIN}"
  code=$?
  set -e
  if [ "${code}" -ne 0 ]; then
    echo "encore-worker-loop: worker exited ${code}; retry in ${IDLE_SLEEP}s" >&2
  else
    echo "encore-worker-loop: queue idle; next poll in ${IDLE_SLEEP}s" >&2
  fi
  sleep "${IDLE_SLEEP}"
done
