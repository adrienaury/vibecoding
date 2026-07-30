#!/usr/bin/env python3
"""
Proxy CORS local minimaliste pour IRRViz.

Yahoo Finance ne renvoie pas de header Access-Control-Allow-Origin, donc un appel
navigateur direct est bloqué par CORS. Ce proxy tourne sur localhost et ajoute le
header CORS manquant avant de renvoyer la réponse au navigateur.

Utilisation :
    python proxy.py
    # ou avec un port personnalisé :
    python proxy.py 8765

L'application IRRViz détecte automatiquement http://localhost:<port>/health et
utilise ce proxy si disponible.

Whitelist : seuls query1.finance.yahoo.com et query2.finance.yahoo.com sont autorisés.
"""

import sys
import re
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

DEFAULT_PORT = 8765
ALLOWED_DOMAINS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")


def add_cors_headers(handler):
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Affiche chaque requête dans la console du proxy.
        print(f"[proxy] {self.address_string()} - {fmt % args}")

    def do_OPTIONS(self):
        self.send_response(204)
        add_cors_headers(self)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # Health check utilisé par IRRViz pour auto-détecter le proxy.
        if parsed.path == "/health":
            self.send_response(200)
            add_cors_headers(self)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        qs = urllib.parse.parse_qs(parsed.query)
        if "url" not in qs or not qs["url"]:
            self.send_response(400)
            add_cors_headers(self)
            self.end_headers()
            self.wfile.write(b'{"error":"missing url parameter"}')
            return

        target = qs["url"][0]
        target_parsed = urllib.parse.urlparse(target)

        if target_parsed.netloc not in ALLOWED_DOMAINS:
            self.send_response(403)
            add_cors_headers(self)
            self.end_headers()
            self.wfile.write(b'{"error":"domain not allowed"}')
            return

        try:
            req = urllib.request.Request(
                target,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"
                    )
                },
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                self.send_response(resp.status)
                add_cors_headers(self)
                # On ne transfère que le Content-Type du downstream ; le reste est
                # soit géré par CORS (length est recalculée implicitement), soit inutile.
                content_type = resp.headers.get("Content-Type")
                if content_type:
                    self.send_header("Content-Type", content_type)
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            add_cors_headers(self)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            add_cors_headers(self)
            self.end_headers()
            self.wfile.write(f'{{"error":"{str(e)}"}}'.encode("utf-8"))


if __name__ == "__main__":
    port = DEFAULT_PORT
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])

    server = HTTPServer(("127.0.0.1", port), ProxyHandler)
    print(f"IRRViz proxy running on http://127.0.0.1:{port}")
    print(f"Health check: http://127.0.0.1:{port}/health")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[proxy] stopping")
        server.server_close()
