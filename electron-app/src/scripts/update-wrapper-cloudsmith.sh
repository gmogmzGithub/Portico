#!/bin/bash

# Wrapper script to run update-cloudsmith.sh completely detached from parent process
# This uses double-fork technique to prevent the update from being killed when Electron exits

PROJECT_ROOT="$1"
DOWNLOAD_URL="$2"
FILENAME="$3"
FULL_SHA="$4"

if [ -z "$PROJECT_ROOT" ] || [ -z "$DOWNLOAD_URL" ] || [ -z "$FILENAME" ] || [ -z "$FULL_SHA" ]; then
    echo "Error: Missing required arguments" >&2
    echo "Usage: $0 <project_root> <download_url> <filename> <full_sha>" >&2
    exit 1
fi

# Create log directory if it doesn't exist
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

# Create a log file for the update process with timestamp
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
LOG_FILE="$LOG_DIR/update-cloudsmith_${TIMESTAMP}.log"
LATEST_LOG="$LOG_DIR/update-latest.log"

# Log initial wrapper start
echo "========================================" > "$LOG_FILE"
echo "Cloudsmith Update Wrapper Started" >> "$LOG_FILE"
echo "Time: $(date)" >> "$LOG_FILE"
echo "PID: $$" >> "$LOG_FILE"
echo "Arguments:" >> "$LOG_FILE"
echo "  PROJECT_ROOT: $PROJECT_ROOT" >> "$LOG_FILE"
echo "  DOWNLOAD_URL: $DOWNLOAD_URL" >> "$LOG_FILE"
echo "  FILENAME: $FILENAME" >> "$LOG_FILE"
echo "  FULL_SHA: $FULL_SHA" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Copy to latest log for easy access
cp "$LOG_FILE" "$LATEST_LOG"

# Double fork to completely detach from parent
(
    # First fork - creates a child process
    (
        # Second fork - orphans the process completely
        # Close all file descriptors to fully detach
        exec 0<&-
        exec 1>&-
        exec 2>&-
        
        # Run the actual update script, appending output to log file
        echo "Launching update script at $(date)" >> "$LOG_FILE"
        bash "$PROJECT_ROOT/electron-app/src/scripts/update-cloudsmith.sh" "$PROJECT_ROOT" "$DOWNLOAD_URL" "$FILENAME" "$FULL_SHA" >> "$LOG_FILE" 2>&1
        EXIT_CODE=$?
        
        echo "" >> "$LOG_FILE"
        echo "========================================" >> "$LOG_FILE"
        echo "Update script completed with exit code: $EXIT_CODE" >> "$LOG_FILE"
        echo "Time: $(date)" >> "$LOG_FILE"
        echo "========================================" >> "$LOG_FILE"
        
        # Update the latest log
        cp "$LOG_FILE" "$LATEST_LOG"
    ) &
) &

echo "Update wrapper launched successfully - check logs at:" >&2
echo "  $LOG_FILE" >&2
echo "  $LATEST_LOG" >&2

# Exit immediately - the update continues in the background
exit 0
