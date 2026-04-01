#!/bin/bash
# Full Tally sync — truncates and reloads all transaction tables
# Called by cron at 2am nightly

set -euo pipefail

TALLY_SYNC_DIR="/home/rajveersingh/Git_apps/purchase_software/tally-sync"
LOG_FILE="$TALLY_SYNC_DIR/import-log.txt"
ERROR_FILE="$TALLY_SYNC_DIR/error-log.txt"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] Starting full sync" >> "$LOG_FILE"

cd "$TALLY_SYNC_DIR"

if node ./dist/index.mjs --tally-sync full --tally-definition tally-export-config-incremental.yaml >> "$LOG_FILE" 2>> "$ERROR_FILE"; then
    EXIT_CODE=0
    echo "[$TIMESTAMP] Full sync completed successfully" >> "$LOG_FILE"
else
    EXIT_CODE=$?
    echo "[$TIMESTAMP] Full sync FAILED with exit code $EXIT_CODE" >> "$ERROR_FILE"
fi

exit $EXIT_CODE
