#!/bin/bash
set -e

# Debug helper script - builds, starts server, and opens browser with debugger

echo "Building project..."
./build.sh

if [ ! -f "build/test_video.h264" ]; then
    echo "Test video not found, generating..."
    ./generate_test_video.sh
fi

echo "Starting server..."
./serve.sh

echo "Opening Chrome with remote debugging..."

# Try to open Chrome with debugging enabled
if command -v google-chrome &> /dev/null; then
    google-chrome --remote-debugging-port=9222 "http://localhost:8765/index.html?filename=./test_video.h264" &
elif command -v chromium &> /dev/null; then
    chromium --remote-debugging-port=9222 "http://localhost:8765/index.html?filename=./test_video.h264" &
elif command -v chromium-browser &> /dev/null; then
    chromium-browser --remote-debugging-port=9222 "http://localhost:8765/index.html?filename=./test_video.h264" &
else
    echo "Chrome/Chromium not found. Please open manually:"
    echo "http://localhost:8765/index.html?filename=./test_video.h264"
fi

echo ""
echo "Debug server running at: http://localhost:8765"
echo "Remote debugging port: 9222"
echo ""
echo "Press Ctrl+C to exit"

# Wait for Ctrl+C
trap 'exit' INT
wait
