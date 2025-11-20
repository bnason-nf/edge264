#!/bin/bash
set -e

# HTTP server with CORS headers for WebAssembly development

if [ ! -d "build" ]; then
    echo "Error: build directory not found. Run ./build.sh first."
    exit 1
fi

# Check if server is already running and kill it if necessary
if lsof -i :8765 > /dev/null 2>&1; then
    echo "Port 8765 is in use. Killing existing process..."
    PID=$(lsof -t -i :8765)
    kill $PID 2>/dev/null || true
    # Wait for port to be released (TCP TIME_WAIT state)
    for i in {1..10}; do
        sleep 0.5
        if ! lsof -i :8765 > /dev/null 2>&1; then
            break
        fi
    done
    # Final check
    if lsof -i :8765 > /dev/null 2>&1; then
        echo "Error: Failed to kill existing server on port 8765"
        echo "Please manually kill process: kill $(lsof -t -i :8765)"
        exit 1
    fi
fi

echo "Starting HTTP server with CORS support..."
echo ""

# Use custom Python server with CORS headers
python3 serve_with_cors.py &
SERVER_PID=$!

# Wait for server to start
sleep 2

# Verify server started
if ! curl -s http://localhost:8765/index.html > /dev/null 2>&1; then
    echo "Error: Server failed to start"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

echo "Server started successfully (PID: $SERVER_PID)"
echo ""
