# Basepanel Bridge

A tiny, single-file script you drop next to your SQLite database to let the
[Basepanel](https://basepanel.com) mobile and desktop apps connect to it  
securely. No SSH, no exposed database port, no extra service to babysit.

> "It's just a file. Upload it, set a token, point Basepanel at the URL."

The bridge accepts a SQL string over HTTPS, runs it against your `.sqlite`
file, and returns JSON. That's the whole job.

## Pick your stack


| Runtime     | File                             | Requirements                                                                                                            |
| ----------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **PHP**     | `[basepanel.php](basepanel.php)` | PHP 8.0+ with the bundled `pdo_sqlite` extension. Drop into any web root served by Apache, nginx + php-fpm, Caddy, etc. |
| **Node.js** | `[basepanel.js](basepanel.js)`   | Node.js 22.5+ (uses the built-in `node:sqlite` module, no `npm install`). Run behind a TLS-terminating reverse proxy.   |
| **Python**  | `[basepanel.py](basepanel.py)`   | Python 3.8+ (stdlib only, no `pip install`). Runs standalone or as a WSGI app.                                          |


All three speak the **same wire protocol**, so the Basepanel client doesn't
care which one you choose.

---

## Quick start (PHP, the easy path)

1. **Download the script.**
  ```bash
   curl -O https://raw.githubusercontent.com/basepanel/basepanel-bridge/main/basepanel.php
  ```
2. **Generate a bearer token** and paste it into the file.
  ```bash
   php -r "echo bin2hex(random_bytes(32));"
   # 9b1f...d3c8
  ```
   Open `basepanel.php` and replace the two values at the top:

```php
'bearer_token'  => '9b1f...d3c8',                    // ← the token you just generated
'database_path' => '/var/www/myapp/data/app.sqlite', // ← absolute path to your database
```

3. **Upload it next to your database**, somewhere your web server can serve.
  ```
   /var/www/myapp/
     ├── public/
     │   └── basepanel.php   ← here
     └── data/
         └── app.sqlite
  ```
4. **Verify it works** in your browser or with curl:
  ```
   GET https://your-site.com/basepanel.php
  ```
   You should see something like:

```json
{
  "ok": true,
  "bridge": "basepanel-bridge-php",
  "version": "1.0.0",
  "protocol": 1,
  "authConfigured": true,
  "readOnly": false,
  "database": { "name": "app.sqlite", "exists": true, "size": 24576, "sqliteVersion": "3.43.2" }
}
```

   If `authConfigured` is `false`, the token at the top of the file is still
   the placeholder.
5. **Add it to Basepanel.** Open the app, choose **Self-Hosted VPS**, and paste:
  - URL: `https://your-site.com/basepanel.php`
  - Token: the one you generated above

That's it. Basepanel can now read and write your database.

---

## Quick start (Node.js)

```bash
curl -O https://raw.githubusercontent.com/basepanel/basepanel-bridge/main/basepanel.js

export BASEPANEL_BEARER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export BASEPANEL_DATABASE_PATH=/var/lib/myapp/app.sqlite

node basepanel.js
# [basepanel] basepanel-bridge-node v1.0.0 listening on http://127.0.0.1:8080
```

Then put nginx, Caddy, or Cloudflare in front to terminate TLS and forward to
`http://127.0.0.1:8080`. The bridge binds to loopback by default so it's only
reachable through your proxy; set `BASEPANEL_HOST=0.0.0.0` if you need to
expose it directly (e.g. inside a container). If your proxy is **not** on the
same machine, also set `BASEPANEL_TRUSTED_PROXIES` to the proxy's IP so its
`X-Forwarded-*` headers are honored. A typical Caddy config:

```caddy
bridge.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

For long-running deployments, run it under `systemd` / `pm2` / Docker. A
minimal `systemd` unit:

```ini
[Unit]
Description=Basepanel Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/lib/myapp
Environment=BASEPANEL_BEARER_TOKEN=...
Environment=BASEPANEL_DATABASE_PATH=/var/lib/myapp/app.sqlite
ExecStart=/usr/bin/node /var/lib/myapp/basepanel.js
Restart=on-failure
User=myapp

[Install]
WantedBy=multi-user.target
```

---

## Quick start (Python)

```bash
curl -O https://raw.githubusercontent.com/basepanel/basepanel-bridge/main/basepanel.py

export BASEPANEL_BEARER_TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(32))")
export BASEPANEL_DATABASE_PATH=/var/lib/myapp/app.sqlite

python3 basepanel.py
```

Or as a WSGI app under gunicorn / uWSGI:

```bash
gunicorn -w 2 -b 127.0.0.1:8080 basepanel:application
```

---

## Configuration

Each script has a `CONFIG` block at the top. The Node and Python versions also
read `BASEPANEL_*` environment variables; the PHP version uses constants only,
since PHP-FPM environments rarely propagate env vars cleanly.


| Setting           | Default             | Description                                                                                                                                                                              |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bearer_token`    | *placeholder*       | **Required.** A long random secret. Treat it like a database password.                                                                                                                   |
| `database_path`   | `./database.sqlite` | Absolute path to the `.sqlite` file you want to expose.                                                                                                                                  |
| `read_only`       | `false`             | If `true`, the database is opened read-only and only `SELECT`, `WITH`, `EXPLAIN`, `PRAGMA`, and `VALUES` statements are accepted. Enforcement comes from the read-only connection itself, not just the keyword check. |
| `require_https`   | `true`              | Reject plain-HTTP requests. Honors `X-Forwarded-Proto`, but only when the request comes from one of `trusted_proxies`. Disable only for local testing.                                   |
| `trust_proxy`     | `true`              | Master switch for honoring `X-Forwarded-*` headers (Node/Python). Headers are still only trusted when the peer is in `trusted_proxies`.                                                  |
| `trusted_proxies` | *loopback*          | Peer addresses allowed to set `X-Forwarded-*` headers. Defaults to `127.0.0.1` / `::1`. Add your load balancer / CDN egress IPs if the proxy isn't on the same machine — otherwise their forwarded headers are ignored. |
| `allowed_ips`     | `[]`                | Optional IP allowlist (exact match). Empty = allow any IP that knows the token. Checked against the client IP as resolved via `trusted_proxies`, so forged `X-Forwarded-For` headers can't bypass it. |
| `allowed_origins` | `["*"]`             | CORS origins. The Basepanel apps (iOS, iPadOS, Android, Mac Catalyst) all use native networking and don't care about CORS, this only matters if you also call the bridge from a browser. |
| `max_body_bytes`  | `4194304`           | Maximum POST body size (4 MB).                                                                                                                                                           |
| `busy_timeout_ms` | `5000`              | SQLite busy timeout, how long to wait for a lock to clear.                                                                                                                               |
| `host` / `port`   | `127.0.0.1` / `8080`| (Node/Python only.) Bind address and port. Loopback by default so only your reverse proxy can reach the bridge; set `host` to `0.0.0.0` to expose it directly.                          |


For Node and Python, override at runtime with env vars: `BASEPANEL_BEARER_TOKEN`,
`BASEPANEL_DATABASE_PATH`, `BASEPANEL_READ_ONLY`, `BASEPANEL_REQUIRE_HTTPS`,
`BASEPANEL_TRUST_PROXY`, `BASEPANEL_TRUSTED_PROXIES` (comma-separated),
`BASEPANEL_ALLOWED_IPS` (comma-separated), `BASEPANEL_ALLOWED_ORIGINS`
(comma-separated), `BASEPANEL_MAX_BODY_BYTES`, `BASEPANEL_BUSY_TIMEOUT_MS`,
`BASEPANEL_HOST`, `BASEPANEL_PORT`.

---

## Security model

The bridge is a deliberate "thin authenticated proxy" to your database. That
means whoever holds the bearer token can run any SQL the configured user can
run. To keep that safe:

1. **Always serve over HTTPS.** Leave `require_https` on. The token is sent in
  an `Authorization` header on every request.
2. **Use a high-entropy token.** At least 32 bytes / 64 hex chars. Generate it
  with the snippets above. Don't pick it yourself.
3. **Treat the token like a password.** Don't commit it; rotate it if it leaks.
4. **Consider read-only mode** if Basepanel only needs to inspect data. Flip
  `read_only` to `true` and you'll reject anything that isn't a read.
5. **Optionally restrict by IP** with `allowed_ips`. Good for fixed-IP devices
  or when paired with a mesh VPN like Tailscale. The client IP is taken from
   `X-Forwarded-For` only when the request comes from a peer listed in
   `trusted_proxies`, so make sure that list matches your proxy setup.
6. **Make sure the SQLite file isn't world-readable** from elsewhere on your
  web root. The bridge uses the path you point it at, but you don't want
   `/data/app.sqlite` to also be downloadable directly.
7. **Watch your access logs.** All three implementations log via the host's
  normal request log (Apache/nginx for PHP, stderr for Node/Python).

The bridge does **not** do its own rate limiting. Use your reverse proxy or
Cloudflare for that if you need it.

---

## Wire protocol (v1)

A single endpoint at the script's URL.

### `GET /` — health / info (no auth)

Returns minimal information so the Basepanel app can validate the deployment
before asking the user for a token. Never includes filesystem paths or any
schema details.

```json
{
  "ok": true,
  "bridge": "basepanel-bridge-php",
  "version": "1.0.0",
  "protocol": 1,
  "authConfigured": true,
  "readOnly": false,
  "database": {
    "name": "app.sqlite",
    "exists": true,
    "size": 24576,
    "sqliteVersion": "3.43.2"
  }
}
```

### `POST /` — execute SQL (auth required)

Send `Authorization: Bearer <token>` and a JSON body. There are two shapes:

**Single statement**

```json
{
  "sql": "SELECT id, name FROM users WHERE id = ?",
  "params": [42]
}
```

**Multiple statements** (run in a single transaction by default)

```json
{
  "statements": [
    { "sql": "INSERT INTO users (name) VALUES (?)", "params": ["Alice"] },
    { "sql": "INSERT INTO users (name) VALUES (?)", "params": ["Bob"] }
  ],
  "transaction": true
}
```

`transaction` defaults to `true` when there is more than one statement and
`false` for a single statement. Set it explicitly to override.

`params` may be a positional array (`[1, "x"]`) or a named object
(`{"id": 1, "name": "x"}` — bound as `:id`, `:name`).

Each `sql` string must contain a **single statement** — anything after the
first statement is not executed. Use the `statements` array to run batches.

### Successful response

```json
{
  "ok": true,
  "protocol": 1,
  "bridge": "basepanel-bridge-php",
  "version": "1.0.0",
  "sqliteVersion": "3.43.2",
  "totalTimeMs": 1.234,
  "results": [
    {
      "columns": ["id", "name"],
      "rows": [[1, "Alice"], [2, "Bob"]],
      "rowsAffected": 0,
      "lastInsertRowid": null,
      "executionTimeMs": 0.512
    }
  ]
}
```

`results` always has the same length as the number of statements. For
non-`SELECT` statements, `columns` and `rows` are empty and `rowsAffected` /
`lastInsertRowid` are populated instead.

### Error response

```json
{
  "ok": false,
  "protocol": 1,
  "error": {
    "code": "SQL_ERROR",
    "message": "near \"SELET\": syntax error",
    "statementIndex": 0
  }
}
```


| HTTP | Code                                          | When                                                       |
| ---- | --------------------------------------------- | ---------------------------------------------------------- |
| 400  | `HTTPS_REQUIRED`                              | The request came in over plain HTTP.                       |
| 400  | `INVALID_JSON`                                | Body wasn't valid JSON.                                    |
| 400  | `INVALID_REQUEST`                             | Neither `sql` nor `statements` provided.                   |
| 400  | `INVALID_STATEMENT` / `INVALID_PARAMS`        | Bad shape inside `statements`.                             |
| 400  | `EMPTY_REQUEST`                               | `statements` was empty.                                    |
| 400  | `SQL_ERROR`                                   | SQLite raised an error (includes `statementIndex`).        |
| 401  | `UNAUTHORIZED`                                | Missing, malformed, or wrong bearer token.                 |
| 403  | `IP_FORBIDDEN`                                | Client IP isn't in the allowlist.                          |
| 403  | `READ_ONLY_VIOLATION`                         | A write was attempted in `read_only` mode.                 |
| 405  | `METHOD_NOT_ALLOWED`                          | Not GET/POST/OPTIONS.                                      |
| 413  | `BODY_TOO_LARGE`                              | Body exceeded `max_body_bytes`.                            |
| 500  | `DATABASE_NOT_FOUND` / `DATABASE_OPEN_FAILED` | The SQLite file is missing or unreadable.                  |
| 500  | `INTERNAL_ERROR`                              | Anything else. The error message is intentionally generic. |


### Binary (BLOB) values

SQLite blobs are encoded both directions as a tagged JSON object so they
survive a JSON round-trip.

```json
{ "$type": "bytes", "base64": "SGVsbG8=" }
```

- **In responses:** any column value that is binary (or is declared as `BLOB`
in PHP, or comes back as `bytes` / `Buffer` in Python / Node) is wrapped in
this shape.
- **In `params`:** send the same shape and the bridge will decode it to bytes
before binding.

`null`, numbers, booleans, and ordinary UTF-8 strings pass through as plain
JSON.

> Note: SQLite integers larger than `2^53 - 1` lose precision once they hit
> JavaScript / JSON. For typical app workloads this is fine; if you need
> bigint precision, query the value as a TEXT and cast.

---

## Examples

### A simple `SELECT`

```bash
curl -X POST https://bridge.example.com/basepanel.php \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "sql": "SELECT id, name FROM users WHERE id = ?", "params": [1] }'
```

### Inserting a BLOB

```bash
curl -X POST https://bridge.example.com/basepanel.php \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "INSERT INTO files (name, data) VALUES (?, ?)",
    "params": ["avatar.png", { "$type": "bytes", "base64": "iVBORw0KGgoAAAANSUhE..." }]
  }'
```

### A migration as a single transaction

```bash
curl -X POST https://bridge.example.com/basepanel.php \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": true,
    "statements": [
      { "sql": "ALTER TABLE users ADD COLUMN email TEXT" },
      { "sql": "CREATE UNIQUE INDEX idx_users_email ON users(email)" }
    ]
  }'
```

If the second statement fails, the first one is rolled back.

---

## Development

The repo includes a smoke-test runner that boots each implementation against a
temporary database and verifies they all speak the same protocol.

```bash
# default: tests basepanel.js
node tests/smoketest.mjs

# pick one
node tests/smoketest.mjs --runtime=php
node tests/smoketest.mjs --runtime=python

# all three
node tests/smoketest.mjs --runtime=all
```

Requires whichever runtimes you want to exercise to be on `PATH`.

---

## License

[MIT](LICENSE) — use it, ship it, fork it.