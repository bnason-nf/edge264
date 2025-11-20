#!/usr/bin/env python3
"""
HTTP server with CORS headers enabled for WebAssembly development.

This server adds the necessary headers for:
- WebAssembly module loading
- SharedArrayBuffer (required for threading)
- Cross-origin isolation
"""

import http.server
import socketserver
import sys
import os
from pathlib import Path
from functools import partial

PORT = 8765

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP request handler with CORS headers."""

    def end_headers(self):
        """Add CORS and security headers to all responses."""
        # Basic CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

        # Required for SharedArrayBuffer (enables threading in WebAssembly)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')

        # Cache control for development
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')

        super().end_headers()

    def do_OPTIONS(self):
        """Handle OPTIONS preflight requests."""
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        """Custom log format with colors."""
        if self.path.endswith(('.wasm', '.js', '.html', '.h264')):
            print(f"\033[32m[SERVE]\033[0m {self.address_string()} - {format % args}")
        else:
            print(f"\033[90m[SERVE]\033[0m {self.address_string()} - {format % args}")

def main():
    # Determine serving directory
    build_dir = Path(__file__).parent / "build"
    if build_dir.exists():
        serve_dir = str(build_dir.resolve())
        print(f"\033[34m[INFO]\033[0m Serving from: {serve_dir}")
    else:
        print(f"\033[33m[WARN]\033[0m Build directory not found. Run ./build.sh first.")
        serve_dir = str(Path.cwd())
        print(f"\033[33m[WARN]\033[0m Serving from: {serve_dir}")

    # Create handler with explicit directory parameter to avoid os.getcwd() issues
    handler = partial(CORSRequestHandler, directory=serve_dir)

    # Start server with socket reuse enabled
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"\033[32m[START]\033[0m Server running at http://localhost:{PORT}")
        print(f"\033[32m[START]\033[0m CORS enabled for WebAssembly")
        print(f"\033[32m[START]\033[0m Cross-Origin Isolation enabled for threading")
        print()
        print(f"\033[34m[INFO]\033[0m Open: http://localhost:{PORT}/index.html")
        print(f"\033[34m[INFO]\033[0m Test: http://localhost:{PORT}/index.html?filename=./test_video.h264")
        print()
        print("\033[90mPress Ctrl+C to stop\033[0m")
        print()

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
            print("\033[33m[STOP]\033[0m Server stopped")
            sys.exit(0)

if __name__ == "__main__":
    main()
