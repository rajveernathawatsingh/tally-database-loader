#!/bin/bash
# Incremental Tally sync — alter_id cursor based, catches all modifications
# Called by cron at 8am, 12pm, 4pm, 8pm

set -euo pipefail

TALLY_SYNC_DIR="/home/rajveersingh/Git_apps/purchase_software/tally-sync"
LOG_FILE="$TALLY_SYNC_DIR/import-log.txt"
ERROR_FILE="$TALLY_SYNC_DIR/error-log.txt"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] Starting incremental sync" >> "$LOG_FILE"

cd "$TALLY_SYNC_DIR"

if node ./dist/index.mjs --tally-sync incremental --tally-definition tally-export-config-incremental.yaml >> "$LOG_FILE" 2>> "$ERROR_FILE"; then
    EXIT_CODE=0
    echo "[$TIMESTAMP] Incremental sync completed successfully" >> "$LOG_FILE"
else
    EXIT_CODE=$?
    echo "[$TIMESTAMP] Incremental sync FAILED with exit code $EXIT_CODE" >> "$ERROR_FILE"
fi

exit $EXIT_CODE
