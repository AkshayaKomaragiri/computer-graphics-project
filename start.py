#!/usr/bin/env python3
"""Serve the complete project locally with correct module MIME types."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import webbrowser

PROJECT_ROOT = Path(__file__).resolve().parent


class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def end_headers(self):
        # Avoid mixing old scripts with a newly pulled HTML page during development.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def create_server(port=8765):
    handler = partial(AppHandler, directory=str(PROJECT_ROOT))
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Start Mars Atlas and open it in your browser.")
    parser.add_argument("--port", type=int, default=8765, help="Local port (default: 8765).")
    parser.add_argument("--no-browser", action="store_true", help="Print the address without opening a browser.")
    args = parser.parse_args(argv)
    try:
        server = create_server(args.port)
    except OSError as error:
        # Another project may already be using the default preview port.
        if args.port != 8765:
            print("Could not start Mars Atlas: {}".format(error), file=sys.stderr)
            return 1
        try:
            server = create_server(0)
        except OSError as fallback_error:
            print("Could not start Mars Atlas: {}".format(fallback_error), file=sys.stderr)
            return 1
    with server:
        url = "http://127.0.0.1:{}/".format(server.server_address[1])
        print("Mars Atlas is running at {}".format(url), flush=True)
        print("Keep this window open while exploring. Press Ctrl+C to stop.", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nMars Atlas stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
