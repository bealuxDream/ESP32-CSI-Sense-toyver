#!/usr/bin/env python3
"""Local viewer and Windows Wi-Fi metrics API; Python standard library only."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import json
import os
import socket
from urllib.parse import urlsplit
import webbrowser
from threading import Thread
from pc_wifi import WifiMonitor


class LocalServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can let an old viewer keep answering the same port.
    allow_reuse_address = False

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path == "/api/pc-wifi":
            allowed = {"localhost:%s" % self.server.server_port, "127.0.0.1:%s" % self.server.server_port}
            origin = self.headers.get("Origin")
            if (self.headers.get("Host") not in allowed or
                    self.headers.get("Sec-Fetch-Site") == "cross-site" or
                    (origin and origin not in {"http://" + x for x in allowed})):
                self.send_error(403, "Local viewer only")
                return
            body = json.dumps(self.server.wifi.snapshot(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        if not urlsplit(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if urlsplit(self.path).path != "/api/pc-wifi":
            super().log_message(fmt, *args)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    server = LocalServer(("127.0.0.1", args.port), partial(Handler, directory=str(root)))
    server.wifi = WifiMonitor()
    url = "http://localhost:%s" % args.port
    print("CSI viewer: " + url)
    print("Use desktop Microsoft Edge / Google Chrome. Ctrl+C to stop.")
    # A browser launcher can block on some machines; do not delay the server.
    if not args.no_browser:
        Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.wifi.close()
        server.server_close()
