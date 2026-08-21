#!/bin/bash

# Launch app with console output suppressed
# This prevents EIO errors in packaged apps

APP_NAME="Portico"

# Find the app
if [[ -d "./dist/mac-arm64/${APP_NAME}.app" ]]; then
    APP_PATH="./dist/mac-arm64/${APP_NAME}.app"
elif [[ -d "./dist/mac-x64/${APP_NAME}.app" ]]; then
    APP_PATH="./dist/mac-x64/${APP_NAME}.app"
else
    echo "Error: Could not find ${APP_NAME}.app"
    exit 1
fi

# Launch with output suppressed
# Redirect to /dev/null to prevent EIO errors
"${APP_PATH}/Contents/MacOS/${APP_NAME}" > /dev/null 2>&1 &

echo "Application launched in background (console output suppressed)"
