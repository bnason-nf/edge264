#!/bin/bash
set -e

# Build script for edge264 WebAssembly module

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Building edge264 WebAssembly module...${NC}"

# Create build directory and configure
mkdir -p build
cd build

echo -e "${BLUE}Configuring with CMake...${NC}"
emcmake cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_TESTING=OFF

# Build the WASM module
echo -e "${BLUE}Building...${NC}"
cmake --build . -j$(nproc)

echo -e "${GREEN}Build complete!${NC}"
echo ""
echo "Output files:"
echo "  - build/edge264.wasm"
echo "  - build/edge264.js"
echo "  - build/index.html"
echo "  - build/index.js"
echo ""
echo "To run: ./serve.sh"
echo "Then open: http://localhost:8765/index.html"
echo ""
echo -e "${BLUE}Note: CORS headers are automatically enabled for WebAssembly${NC}"
