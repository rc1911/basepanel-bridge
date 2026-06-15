#!/usr/bin/env python3
"""
Basepanel Bridge — single-file SQLite proxy for Python.

Drop this file onto your VPS next to your .sqlite database, set the
BEARER_TOKEN and DATABASE_PATH below (or via env vars), and point the
Basepanel app at its public URL.

  https://basepanel.com
  https://github.com/basepanel/basepanel-bridge

Requirements:
  - Python 3.8+ (stdlib only — no pip install)
  - A reverse proxy (nginx, Caddy, Cloudflare, ...) terminating TLS in front

Run standalone:
  python3 basepanel.py

Or as a WSGI app (`application` is exported), e.g. with gunicorn:
  gunicorn -w 2 -b 127.0.0.1:8080 basepanel:application

License: MIT
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

# =============================================================================
#  CONFIG — edit these values, or set the BASEPANEL_* environment variables.
# =============================================================================


def _bool(v: Optional[str], default: bool) -> bool:
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes", "on")


def _list(v: Optional[str]) -> Optional[List[str]]:
    if not v:
        return None
    return [s.strip() for s in v.split(",") if s.strip()]


CONFIG: Dict[str, Any] = {
    # REQUIRED. Generate with:
    #   python3 -c "import secrets; print(secrets.token_hex(32))"
    "bearer_token": os.environ.get(
        "BASEPANEL_BEARER_TOKEN", "REPLACE_ME_WITH_A_LONG_RANDOM_TOKEN"
    ),
    "database_path": os.environ.get(
        "BASEPANEL_DATABASE_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "database.sqlite"),
    ),
    "read_only": _bool(os.environ.get("BASEPANEL_READ_ONLY"), False),
    "require_https": _bool(os.environ.get("BASEPANEL_REQUIRE_HTTPS"), True),
    "trust_proxy": _bool(os.environ.get("BASEPANEL_TRUST_PROXY"), True),
    # Peer addresses allowed to set X-Forwarded-* headers (your reverse
    # proxy). Forwarded headers from any other peer are ignored, so they
    # can't be spoofed to bypass require_https or allowed_ips. If your
    # proxy isn't on localhost, add its address here.
    "trusted_proxies": _list(os.environ.get("BASEPANEL_TRUSTED_PROXIES"))
    or ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
    "allowed_ips": _list(os.environ.get("BASEPANEL_ALLOWED_IPS")) or [],
    "allowed_origins": _list(os.environ.get("BASEPANEL_ALLOWED_ORIGINS")) or ["*"],
    "max_body_bytes": int(os.environ.get("BASEPANEL_MAX_BODY_BYTES", 4 * 1024 * 1024)),
    "busy_timeout_ms": int(os.environ.get("BASEPANEL_BUSY_TIMEOUT_MS", 5000)),
    # Loopback by default so the bridge is only reachable through your
    # reverse proxy; set BASEPANEL_HOST=0.0.0.0 to expose it directly.
    "host": os.environ.get("BASEPANEL_HOST", "127.0.0.1"),
    "port": int(os.environ.get("BASEPANEL_PORT", 8080)),
}

# =============================================================================
#  IMPLEMENTATION — no edits required below.
# =============================================================================

BRIDGE_NAME = "basepanel-bridge-python"
BRIDGE_VERSION = "1.0.0"
PROTOCOL_VERSION = 1
PLACEHOLDER_TOKEN = "REPLACE_ME_WITH_A_LONG_RANDOM_TOKEN"

_SAFE_READ = re.compile(r"^(SELECT|WITH|EXPLAIN|PRAGMA|VALUES)\b", re.IGNORECASE)
_RETURNING = re.compile(r"\bRETURNING\b", re.IGNORECASE)
_BEARER = re.compile(r"^Bearer\s+(\S+)$", re.IGNORECASE)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"--[^\n]*")


# --- Core handler -----------------------------------------------------------


class BridgeError(Exception):
    def __init__(self, status: int, code: str, message: str, statement_index: Optional[int] = None):
        self.status = status
        self.code = code
        self.message = message
        self.statement_index = statement_index


def handle(method: str, path: str, headers: Dict[str, str], body: bytes,
           remote_ip: str, scheme: str) -> Tuple[int, Dict[str, str], bytes]:
    cors_headers = _cors_headers(headers.get("origin", ""), CONFIG["allowed_origins"])

    if method == "OPTIONS":
        return 204, cors_headers, b""

    try:
        if CONFIG["require_https"] and not _is_https(scheme, headers, remote_ip):
            raise BridgeError(400, "HTTPS_REQUIRED", "This bridge must be served over HTTPS.")

        if CONFIG["allowed_ips"] and _client_ip(remote_ip, headers) not in CONFIG["allowed_ips"]:
            raise BridgeError(403, "IP_FORBIDDEN", "Client IP is not in the allowlist.")

        if method in ("GET", "HEAD"):
            payload = _info_payload()
            return _ok(200, cors_headers, payload, head_only=(method == "HEAD"))

        if method != "POST":
            raise BridgeError(405, "METHOD_NOT_ALLOWED", "Only GET and POST are supported.")

        if not _token_valid(headers.get("authorization", ""), CONFIG["bearer_token"]):
            raise BridgeError(401, "UNAUTHORIZED", "Missing or invalid bearer token.")

        if len(body) > CONFIG["max_body_bytes"]:
            raise BridgeError(413, "BODY_TOO_LARGE",
                              f"Request body exceeds {CONFIG['max_body_bytes']} bytes.")

        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            raise BridgeError(400, "INVALID_JSON", "Request body must be a JSON object.")
        if not isinstance(payload, dict):
            raise BridgeError(400, "INVALID_JSON", "Request body must be a JSON object.")

        statements = _normalize_statements(payload)
        use_tx = bool(payload.get("transaction", len(statements) > 1))

        conn = _open_database(CONFIG["database_path"], CONFIG["read_only"], CONFIG["busy_timeout_ms"])
        try:
            start = time.perf_counter()
            results = _execute(conn, statements, use_tx, CONFIG["read_only"])
            total_ms = (time.perf_counter() - start) * 1000
            sqlite_version = sqlite3.sqlite_version
        finally:
            conn.close()

        return _ok(200, cors_headers, {
            "ok": True,
            "protocol": PROTOCOL_VERSION,
            "bridge": BRIDGE_NAME,
            "version": BRIDGE_VERSION,
            "sqliteVersion": sqlite_version,
            "totalTimeMs": round(total_ms, 3),
            "results": results,
        })

    except BridgeError as e:
        return _err(cors_headers, e)
    except Exception:
        # Don't leak internals.
        return _err(cors_headers, BridgeError(500, "INTERNAL_ERROR",
                                              "Unexpected error while handling request."))


# --- Helpers ---------------------------------------------------------------


def _cors_headers(origin: str, allowed: List[str]) -> Dict[str, str]:
    headers: Dict[str, str] = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
    }
    if "*" in allowed:
        headers["Access-Control-Allow-Origin"] = "*"
    elif origin and origin in allowed:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return headers


def _is_from_trusted_proxy(remote: str) -> bool:
    return CONFIG["trust_proxy"] and remote in CONFIG["trusted_proxies"]


def _is_https(scheme: str, headers: Dict[str, str], remote: str) -> bool:
    if scheme == "https":
        return True
    if _is_from_trusted_proxy(remote):
        # Take the last (right-most) entry: it's the one set by our own proxy.
        proto = headers.get("x-forwarded-proto", "").split(",")[-1].strip().lower()
        if proto == "https":
            return True
    return False


def _client_ip(remote: str, headers: Dict[str, str]) -> str:
    if _is_from_trusted_proxy(remote):
        # Right-most X-Forwarded-For entry is appended by our trusted proxy;
        # anything left of it is client-supplied and spoofable.
        parts = [p.strip() for p in headers.get("x-forwarded-for", "").split(",") if p.strip()]
        if parts:
            return parts[-1]
    return remote


def _token_valid(auth_header: str, expected: str) -> bool:
    m = _BEARER.match(auth_header or "")
    if not m:
        return False
    if not expected or expected == PLACEHOLDER_TOKEN:
        return False
    # Hash both sides so the comparison is constant-time and constant-length
    # (comparing raw values would leak the token's length).
    a = hashlib.sha256(expected.encode("utf-8")).digest()
    b = hashlib.sha256(m.group(1).encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def _normalize_statements(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(payload.get("statements"), list):
        raw = payload["statements"]
    elif isinstance(payload.get("sql"), str):
        raw = [{"sql": payload["sql"], "params": payload.get("params", [])}]
    else:
        raise BridgeError(400, "INVALID_REQUEST", 'Provide a "sql" string or "statements" array.')

    if len(raw) == 0:
        raise BridgeError(400, "EMPTY_REQUEST", "No SQL statements were provided.")

    out: List[Dict[str, Any]] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict) or not isinstance(entry.get("sql"), str):
            raise BridgeError(400, "INVALID_STATEMENT",
                              f"Statement #{i} must contain a 'sql' string.", statement_index=i)
        params = entry.get("params", [])
        if params is None:
            params = []
        if not isinstance(params, (list, dict)):
            raise BridgeError(400, "INVALID_PARAMS",
                              f"Statement #{i} 'params' must be an array or object.", statement_index=i)
        out.append({"sql": entry["sql"], "params": params})
    return out


def _open_database(path: str, read_only: bool, busy_ms: int) -> sqlite3.Connection:
    if not os.path.isfile(path):
        raise BridgeError(500, "DATABASE_NOT_FOUND", "Database file does not exist on the server.")
    try:
        if read_only:
            uri = "file:" + os.path.abspath(path) + "?mode=ro"
            conn = sqlite3.connect(uri, uri=True, isolation_level=None, check_same_thread=False)
        else:
            conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    except sqlite3.Error:
        raise BridgeError(500, "DATABASE_OPEN_FAILED", "Could not open the SQLite database.")

    if busy_ms > 0:
        conn.execute(f"PRAGMA busy_timeout = {int(busy_ms)}")
    if read_only:
        try:
            conn.execute("PRAGMA query_only = 1")
        except sqlite3.Error:
            pass
    return conn


def _execute(conn: sqlite3.Connection, statements: List[Dict[str, Any]],
             use_tx: bool, read_only: bool) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    if use_tx:
        conn.execute("BEGIN")
    try:
        for i, s in enumerate(statements):
            if read_only and not _is_safe_read(s["sql"]):
                raise BridgeError(403, "READ_ONLY_VIOLATION",
                                  f"Statement #{i} is not allowed in read-only mode.",
                                  statement_index=i)

            params = _decode_params(s["params"])
            started = time.perf_counter()
            try:
                cur = conn.execute(s["sql"], params)
            except sqlite3.Error as e:
                raise BridgeError(400, "SQL_ERROR", str(e), statement_index=i)

            try:
                if cur.description:
                    columns = [d[0] for d in cur.description]
                    rows = [
                        [_encode_value(v) for v in row]
                        for row in cur.fetchall()
                    ]
                    results.append({
                        "columns": columns,
                        "rows": rows,
                        "rowsAffected": 0,
                        "lastInsertRowid": None,
                        "executionTimeMs": round((time.perf_counter() - started) * 1000, 3),
                    })
                else:
                    last = cur.lastrowid
                    results.append({
                        "columns": [],
                        "rows": [],
                        "rowsAffected": cur.rowcount if cur.rowcount != -1 else 0,
                        "lastInsertRowid": last if last else None,
                        "executionTimeMs": round((time.perf_counter() - started) * 1000, 3),
                    })
            finally:
                cur.close()

        if use_tx:
            conn.execute("COMMIT")
    except BaseException:
        if use_tx:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
        raise
    return results


def _is_safe_read(sql: str) -> bool:
    stripped = _BLOCK_COMMENT.sub(" ", sql)
    stripped = _LINE_COMMENT.sub(" ", stripped)
    return bool(_SAFE_READ.match(stripped.lstrip()))


def _decode_params(params: Any) -> Any:
    if isinstance(params, list):
        return [_decode_value(v) for v in params]
    if isinstance(params, dict):
        return {k: _decode_value(v) for k, v in params.items()}
    return []


def _decode_value(v: Any) -> Any:
    if isinstance(v, dict) and v.get("$type") == "bytes" and isinstance(v.get("base64"), str):
        try:
            return base64.b64decode(v["base64"], validate=True)
        except (base64.binascii.Error, ValueError):
            return b""
    if isinstance(v, bool):
        return 1 if v else 0
    return v


def _encode_value(v: Any) -> Any:
    if isinstance(v, (bytes, bytearray, memoryview)):
        return {"$type": "bytes", "base64": base64.b64encode(bytes(v)).decode("ascii")}
    return v


def _info_payload() -> Dict[str, Any]:
    # This endpoint is unauthenticated, so it returns only non-sensitive
    # liveness info. Database details (name, size, SQLite version) are
    # intentionally omitted to avoid leaking metadata to anonymous callers.
    return {
        "ok": True,
        "bridge": BRIDGE_NAME,
        "version": BRIDGE_VERSION,
        "protocol": PROTOCOL_VERSION,
        "authConfigured": bool(CONFIG["bearer_token"]) and CONFIG["bearer_token"] != PLACEHOLDER_TOKEN,
    }


def _ok(status: int, cors: Dict[str, str], data: Any, head_only: bool = False) -> Tuple[int, Dict[str, str], bytes]:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": str(len(body)),
        **cors,
    }
    return status, headers, b"" if head_only else body


def _err(cors: Dict[str, str], err: BridgeError) -> Tuple[int, Dict[str, str], bytes]:
    payload: Dict[str, Any] = {
        "ok": False,
        "protocol": PROTOCOL_VERSION,
        "error": {"code": err.code, "message": err.message},
    }
    if err.statement_index is not None:
        payload["error"]["statementIndex"] = err.statement_index
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": str(len(body)),
        **cors,
    }
    return err.status, headers, body


# --- WSGI entrypoint -------------------------------------------------------


def application(environ, start_response):
    method = environ.get("REQUEST_METHOD", "GET").upper()
    headers: Dict[str, str] = {}
    for k, v in environ.items():
        if k.startswith("HTTP_"):
            headers[k[5:].replace("_", "-").lower()] = v
    if "CONTENT_TYPE" in environ:
        headers.setdefault("content-type", environ["CONTENT_TYPE"])

    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if length > CONFIG["max_body_bytes"]:
        body = b""
        # Drain to keep the connection healthy
        try:
            environ["wsgi.input"].read(length)
        except Exception:
            pass
        status, hdrs, body = _err(_cors_headers(headers.get("origin", ""), CONFIG["allowed_origins"]),
                                  BridgeError(413, "BODY_TOO_LARGE",
                                              f"Request body exceeds {CONFIG['max_body_bytes']} bytes."))
    else:
        body = environ["wsgi.input"].read(length) if length > 0 else b""
        remote = environ.get("REMOTE_ADDR", "")
        scheme = environ.get("wsgi.url_scheme", "http")
        status, hdrs, body = handle(method, environ.get("PATH_INFO", "/"), headers, body, remote, scheme)

    reason = {200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized",
              403: "Forbidden", 405: "Method Not Allowed", 413: "Payload Too Large",
              500: "Internal Server Error"}.get(status, "OK")
    start_response(f"{status} {reason}", list(hdrs.items()))
    return [body]


# --- Standalone server -----------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    server_version = f"{BRIDGE_NAME}/{BRIDGE_VERSION}"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("[basepanel] " + (format % args) + "\n")

    def _serve(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else b""
        headers = {k.lower(): v for k, v in self.headers.items()}
        remote = self.client_address[0] if self.client_address else ""
        scheme = "https" if getattr(self.server, "use_https", False) else "http"
        status, hdrs, payload = handle(self.command, self.path, headers, body, remote, scheme)
        self.send_response(status)
        for k, v in hdrs.items():
            self.send_header(k, v)
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def do_GET(self) -> None: self._serve()
    def do_HEAD(self) -> None: self._serve()
    def do_POST(self) -> None: self._serve()
    def do_OPTIONS(self) -> None: self._serve()


def main() -> int:
    addr = (CONFIG["host"], CONFIG["port"])
    server = ThreadingHTTPServer(addr, _Handler)
    token_ok = CONFIG["bearer_token"] and CONFIG["bearer_token"] != PLACEHOLDER_TOKEN
    sys.stderr.write(
        f"[basepanel] {BRIDGE_NAME} v{BRIDGE_VERSION} listening on http://{addr[0]}:{addr[1]}\n"
    )
    sys.stderr.write(
        f"[basepanel] database: {os.path.basename(CONFIG['database_path'])}  "
        f"read_only: {CONFIG['read_only']}  auth: {'configured' if token_ok else 'NOT CONFIGURED'}\n"
    )
    if not token_ok:
        sys.stderr.write("[basepanel] WARNING: bearer token is unset or still the placeholder.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("[basepanel] shutting down...\n")
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
