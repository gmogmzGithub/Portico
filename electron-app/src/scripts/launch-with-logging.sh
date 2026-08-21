#!/bin/bash

# Launch Portico with proper logging
# This script prevents EIO errors by redirecting output to log files

APP_NAME="Portico"
LOG_DIR="$HOME/Library/Logs/Portico"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/app_${TIMESTAMP}.log"
ERROR_FILE="$LOG_DIR/error_${TIMESTAMP}.log"

# Create logs directory if it doesn't exist
mkdir -p "$LOG_DIR"

# Find the app path
if [[ "$1" != "" ]]; then
    APP_PATH="$1"
elif [[ -d "./dist/mac-arm64/${APP_NAME}.app" ]]; then
    APP_PATH="./dist/mac-arm64/${APP_NAME}.app"
elif [[ -d "./dist/mac-x64/${APP_NAME}.app" ]]; then
    APP_PATH="./dist/mac-x64/${APP_NAME}.app"
else
    echo "Error: Could not find ${APP_NAME}.app"
    echo "Usage: $0 [path-to-app]"
    exit 1
fi

echo "Starting ${APP_NAME}..."
echo "Logs will be written to:"
echo "  - Output: ${LOG_FILE}"
echo "  - Errors: ${ERROR_FILE}"

# Launch the app with output redirected to files
# This prevents EIO errors when console is not available
"${APP_PATH}/Contents/MacOS/${APP_NAME}" >> "${LOG_FILE}" 2>> "${ERROR_FILE}" &

# Get the PID
APP_PID=$!
echo "Application started with PID: ${APP_PID}"

# Optional: tail the log file to see output in real-time
echo ""
echo "Showing log output (press Ctrl+C to stop viewing, app will continue running):"
echo "-------------------------------------------------------------------"
tail -f "${LOG_FILE}"