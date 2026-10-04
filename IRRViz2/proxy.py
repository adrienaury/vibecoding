#!/usr/bin/env python3
"""
Proxy CORS local minimaliste pour IRRViz 2.

Yahoo Finance ne renvoie pas d'en-tête Access-Control-Allow-Origin : un appel direct
depuis le navigateur est bloqué. Ce proxy tourne sur 127.0.0.1 et ajoute les en-têtes
CORS manquants avant de renvoyer la réponse.

Utilisation :
    python proxy.py          # port 8765 par défaut
    python proxy.py 9000     # port personnalisé (à reporter dans IRRViz 2 › Proxy local)

Seuls query1.finance.yahoo.com et query2.finance.yahoo.com sont autorisés.
Bibliothèque standard uniquement.
"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8765
ALLOWED_DOMAINS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[proxy] {self.address_string()} - {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome (Private Network Access) : autorise une page publique (ex. GitHub Pages)
        # à joindre ce serveur local.
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/health":
            self._json(200, {"ok": True, "app": "irrviz-proxy"})
            return

        target = (urllib.parse.parse_qs(parsed.query).get("url") or [""])[0]
        if not target:
            self._json(400, {"error": "missing url parameter"})
            return

        target_parsed = urllib.parse.urlparse(target)
        if target_parsed.scheme != "https" or target_parsed.hostname not in ALLOWED_DOMAINS:
            self._json(403, {"error": "domain not allowed"})
            return

        try:
            req = urllib.request.Request(target, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self._cors()
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # réseau, timeout, DNS…
            self._json(502, {"error": str(e)})


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        if not sys.argv[1].isdigit():
            sys.exit(f"Port invalide : {sys.argv[1]}")
        port = int(sys.argv[1])

    server = ThreadingHTTPServer(("127.0.0.1", port), ProxyHandler)
    print(f"IRRViz proxy en écoute sur http://127.0.0.1:{port}")
    print(f"Vérification : http://127.0.0.1:{port}/health")
    print("Ctrl+C pour arrêter.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[proxy] arrêt")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
