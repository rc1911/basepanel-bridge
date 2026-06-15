#!/usr/bin/env node
'use strict';

/**
 * Basepanel Bridge — single-file SQLite proxy for Node.js.
 *
 * Drop this file onto your VPS next to your .sqlite database, set the
 * BEARER_TOKEN and DATABASE_PATH below (or via env vars), and point the
 * Basepanel app at its public URL.
 *
 *   https://basepanel.com
 *   https://github.com/basepanel/basepanel-bridge
 *
 * Requirements:
 *   - Node.js 22.5+ (uses the built-in `node:sqlite` module)
 *   - A reverse proxy (nginx, Caddy, Cloudflare, ...) terminating TLS in front
 *
 * Run:
 *   node basepanel.js
 *
 * License: MIT
 */

// =============================================================================
//  CONFIG — edit these values, or set the BASEPANEL_* environment variables.
// =============================================================================

const config = {
  /**
   * REQUIRED. A long random secret. Anyone who knows this token can run
   * arbitrary SQL against your database, so treat it like a password.
   *
   * Generate one with:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   */
  bearer_token: process.env.BASEPANEL_BEARER_TOKEN ||
    'REPLACE_ME_WITH_A_LONG_RANDOM_TOKEN',

  /** Absolute path to the SQLite file you want to expose. */
  database_path: process.env.BASEPANEL_DATABASE_PATH ||
    './database.sqlite',

  /** If true, only read-only statements (SELECT/WITH/...) are accepted. */
  read_only: parseBool(process.env.BASEPANEL_READ_ONLY, false),

  /**
   * Refuse plain-HTTP requests. Honors the `X-Forwarded-Proto` header, but
   * only when the request arrives from one of `trusted_proxies`.
   */
  require_https: parseBool(process.env.BASEPANEL_REQUIRE_HTTPS, true),
  trust_proxy: parseBool(process.env.BASEPANEL_TRUST_PROXY, true),

  /**
   * Peer addresses allowed to set `X-Forwarded-*` headers (your reverse
   * proxy). Forwarded headers from any other peer are ignored, so they
   * can't be spoofed to bypass `require_https` or `allowed_ips`. If your
   * proxy isn't on localhost, add its address here.
   */
  trusted_proxies: parseList(process.env.BASEPANEL_TRUSTED_PROXIES) ??
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'],

  /** Optional IP allowlist (exact match against the client's address). */
  allowed_ips: parseList(process.env.BASEPANEL_ALLOWED_IPS) ?? [],

  /**
   * CORS origins. The Basepanel apps (iOS, iPadOS, Android, Mac Catalyst)
   * use native networking and ignore CORS — only set this if you also call
   * the bridge from a browser.
   */
  allowed_origins: parseList(process.env.BASEPANEL_ALLOWED_ORIGINS) ?? ['*'],

  /** Maximum POST body size. */
  max_body_bytes: parseInt(process.env.BASEPANEL_MAX_BODY_BYTES, 10) ||
    4 * 1024 * 1024,

  /** SQLite busy timeout in milliseconds. */
  busy_timeout_ms: parseInt(process.env.BASEPANEL_BUSY_TIMEOUT_MS, 10) || 5000,

  /**
   * Server bind address. Defaults to loopback so the bridge is only
   * reachable through your reverse proxy; set BASEPANEL_HOST=0.0.0.0 to
   * expose it directly (e.g. inside a container).
   */
  host: process.env.BASEPANEL_HOST || '127.0.0.1',
  port: parseInt(process.env.BASEPANEL_PORT, 10) || 8080,
};

// =============================================================================
//  IMPLEMENTATION — no edits required below.
// =============================================================================

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BRIDGE_NAME = 'basepanel-bridge-node';
const BRIDGE_VERSION = '1.0.0';
const PROTOCOL_VERSION = 1;
const PLACEHOLDER_TOKEN = 'REPLACE_ME_WITH_A_LONG_RANDOM_TOKEN';

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error(
    '[basepanel] node:sqlite is not available. Use Node.js 22.5+, ' +
    'or start node with --experimental-sqlite on 22.5–23.x.'
  );
  process.exit(1);
}

// -----------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('[basepanel] unhandled error:', err);
    if (!res.headersSent) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected error while handling request.');
    } else {
      try { res.end(); } catch (_) { /* ignore */ }
    }
  }
});

server.listen(config.port, config.host, () => {
  const dbName = path.basename(config.database_path);
  const tokenOk = config.bearer_token && config.bearer_token !== PLACEHOLDER_TOKEN;
  console.log(`[basepanel] ${BRIDGE_NAME} v${BRIDGE_VERSION} listening on http://${config.host}:${config.port}`);
  console.log(`[basepanel] database: ${dbName}  read_only: ${config.read_only}  auth: ${tokenOk ? 'configured' : 'NOT CONFIGURED'}`);
  if (!tokenOk) {
    console.warn('[basepanel] WARNING: bearer token is unset or still the placeholder.');
  }
});

// -----------------------------------------------------------------------------

async function handleRequest(req, res) {
  applyCors(req, res, config.allowed_origins);

  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (config.require_https && !isHttps(req)) {
    return sendError(res, 400, 'HTTPS_REQUIRED', 'This bridge must be served over HTTPS.');
  }

  if (config.allowed_ips.length > 0 && !config.allowed_ips.includes(clientIp(req))) {
    return sendError(res, 403, 'IP_FORBIDDEN', 'Client IP is not in the allowlist.');
  }

  if (method === 'GET' || method === 'HEAD') {
    return sendInfo(res);
  }
  if (method !== 'POST') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET and POST are supported.');
  }

  if (!isTokenValid(req, config.bearer_token)) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid bearer token.');
  }

  let body;
  try {
    body = await readBody(req, config.max_body_bytes);
  } catch (err) {
    return sendError(res, err.status || 400, err.code || 'BODY_READ_ERROR', err.message);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (_) {
    return sendError(res, 400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return sendError(res, 400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }

  let statements;
  try {
    statements = normalizeStatements(payload);
  } catch (err) {
    return sendError(res, 400, err.code || 'INVALID_REQUEST', err.message, err.statementIndex);
  }

  const useTx = Object.prototype.hasOwnProperty.call(payload, 'transaction')
    ? !!payload.transaction
    : statements.length > 1;

  let db;
  try {
    db = openDatabase(config.database_path, config.read_only, config.busy_timeout_ms);
  } catch (err) {
    return sendError(res, 500, err.code || 'DATABASE_OPEN_FAILED', err.message);
  }

  const start = process.hrtime.bigint();
  let results;
  try {
    results = executeStatements(db, statements, useTx, config.read_only);
  } catch (err) {
    if (err.code === 'READ_ONLY_VIOLATION') {
      db.close();
      return sendError(res, 403, err.code, err.message, err.statementIndex);
    }
    db.close();
    return sendError(res, 400, 'SQL_ERROR', err.message, err.statementIndex);
  }

  const totalMs = Number(process.hrtime.bigint() - start) / 1e6;

  let sqliteVersion = null;
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get();
    if (row) sqliteVersion = row.v;
  } catch (_) {
    // best-effort
  }
  db.close();

  sendJson(res, 200, {
    ok: true,
    protocol: PROTOCOL_VERSION,
    bridge: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    sqliteVersion,
    totalTimeMs: round3(totalMs),
    results,
  });
}

// --- Request helpers ---------------------------------------------------------

function applyCors(req, res, origins) {
  const origin = req.headers.origin || '';
  if (origins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isFromTrustedProxy(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  return config.trust_proxy && config.trusted_proxies.includes(peer);
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (isFromTrustedProxy(req)) {
    // Take the last (right-most) entry: it's the one set by our own proxy.
    const parts = (req.headers['x-forwarded-proto'] || '').toString().split(',');
    const proto = parts[parts.length - 1].trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return false;
}

function clientIp(req) {
  if (isFromTrustedProxy(req)) {
    // Right-most X-Forwarded-For entry is appended by our trusted proxy;
    // anything left of it is client-supplied and spoofable.
    const parts = (req.headers['x-forwarded-for'] || '').toString()
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
}

function isTokenValid(req, expected) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return false;
  if (!expected || expected === PLACEHOLDER_TOKEN) return false;

  // Hash both sides so the comparison is constant-time and constant-length
  // (a raw length check would leak the token's length).
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(m[1]).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10) || 0;
    if (declared > maxBytes) {
      const e = new Error(`Request body exceeds ${maxBytes} bytes.`);
      e.code = 'BODY_TOO_LARGE';
      e.status = 413;
      return reject(e);
    }
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        const e = new Error(`Request body exceeds ${maxBytes} bytes.`);
        e.code = 'BODY_TOO_LARGE';
        e.status = 413;
        return reject(e);
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeStatements(payload) {
  let list;
  if (Array.isArray(payload.statements)) {
    list = payload.statements;
  } else if (typeof payload.sql === 'string') {
    list = [{ sql: payload.sql, params: payload.params ?? [] }];
  } else {
    const e = new Error('Provide a "sql" string or "statements" array.');
    e.code = 'INVALID_REQUEST';
    throw e;
  }

  if (list.length === 0) {
    const e = new Error('No SQL statements were provided.');
    e.code = 'EMPTY_REQUEST';
    throw e;
  }

  return list.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || typeof entry.sql !== 'string') {
      const e = new Error(`Statement #${i} must contain a 'sql' string.`);
      e.code = 'INVALID_STATEMENT';
      e.statementIndex = i;
      throw e;
    }
    const params = entry.params ?? [];
    if (params !== null && typeof params !== 'object') {
      const e = new Error(`Statement #${i} 'params' must be an array or object.`);
      e.code = 'INVALID_PARAMS';
      e.statementIndex = i;
      throw e;
    }
    return { sql: entry.sql, params };
  });
}

// --- Database ----------------------------------------------------------------

function openDatabase(dbPath, readOnly, busyMs) {
  if (!fs.existsSync(dbPath)) {
    const e = new Error('Database file does not exist on the server.');
    e.code = 'DATABASE_NOT_FOUND';
    throw e;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: !!readOnly });
  } catch (err) {
    const e = new Error('Could not open the SQLite database.');
    e.code = 'DATABASE_OPEN_FAILED';
    throw e;
  }
  if (busyMs > 0) {
    db.exec(`PRAGMA busy_timeout = ${busyMs | 0}`);
  }
  if (readOnly) {
    try { db.exec('PRAGMA query_only = 1'); } catch (_) { /* read-only mode handles it */ }
  }
  return db;
}

function executeStatements(db, statements, useTx, readOnly) {
  const results = [];
  if (useTx) db.exec('BEGIN');
  try {
    for (let i = 0; i < statements.length; i++) {
      const s = statements[i];
      if (readOnly && !isSafeRead(s.sql)) {
        const e = new Error(`Statement #${i} is not allowed in read-only mode.`);
        e.code = 'READ_ONLY_VIOLATION';
        e.statementIndex = i;
        throw e;
      }

      const started = process.hrtime.bigint();
      let stmt;
      try {
        stmt = db.prepare(s.sql);
      } catch (err) {
        err.statementIndex = i;
        throw err;
      }

      const args = decodeParams(s.params);
      let result;
      try {
        if (statementReturnsRows(s.sql)) {
          const rows = applyParams(stmt, args, 'all');
          result = buildSelectResult(stmt, rows);
        } else {
          const r = applyParams(stmt, args, 'run');
          result = buildRunResult(r);
        }
      } catch (err) {
        err.statementIndex = i;
        throw err;
      }

      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      result.executionTimeMs = round3(elapsedMs);
      results.push(result);
    }
    if (useTx) db.exec('COMMIT');
  } catch (err) {
    if (useTx) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw err;
  }
  return results;
}

function statementReturnsRows(sql) {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trimStart();
  // RETURNING clauses on INSERT/UPDATE/DELETE also produce rows.
  if (/\bRETURNING\b/i.test(stripped)) return true;
  return /^(SELECT|WITH|EXPLAIN|PRAGMA|VALUES)\b/i.test(stripped);
}

function applyParams(stmt, args, method) {
  if (Array.isArray(args)) {
    return method === 'all' ? stmt.all(...args) : stmt.run(...args);
  }
  return method === 'all' ? stmt.all(args) : stmt.run(args);
}

function buildSelectResult(stmt, rows) {
  let columns = [];
  try {
    if (typeof stmt.columns === 'function') {
      const c = stmt.columns();
      if (Array.isArray(c)) columns = c.map((col) => col.name || col.column || '');
    }
  } catch (_) { /* fallthrough */ }
  if (columns.length === 0 && rows.length > 0 && rows[0] && typeof rows[0] === 'object') {
    columns = Object.keys(rows[0]);
  }
  const arrayRows = rows.map((row) => columns.map((c) => encodeValue(row[c])));
  return {
    columns,
    rows: arrayRows,
    rowsAffected: 0,
    lastInsertRowid: null,
  };
}

function buildRunResult(r) {
  const lastId = r && r.lastInsertRowid != null
    ? (typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid)
    : null;
  return {
    columns: [],
    rows: [],
    rowsAffected: r && r.changes != null ? Number(r.changes) : 0,
    lastInsertRowid: lastId === 0 ? null : lastId,
  };
}

function decodeParams(params) {
  if (Array.isArray(params)) return params.map(decodeValue);
  if (params && typeof params === 'object') {
    const out = {};
    for (const k of Object.keys(params)) out[k] = decodeValue(params[k]);
    return out;
  }
  return [];
}

function decodeValue(v) {
  if (v && typeof v === 'object' && v.$type === 'bytes' && typeof v.base64 === 'string') {
    return Buffer.from(v.base64, 'base64');
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function encodeValue(v) {
  if (v == null) return v;
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) return { $type: 'bytes', base64: v.toString('base64') };
  if (v instanceof Uint8Array) return { $type: 'bytes', base64: Buffer.from(v).toString('base64') };
  return v;
}

function isSafeRead(sql) {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trimStart();
  return /^(SELECT|WITH|EXPLAIN|PRAGMA|VALUES)\b/i.test(stripped);
}

// --- Responses ---------------------------------------------------------------

function sendInfo(res) {
  // This endpoint is unauthenticated, so it returns only non-sensitive
  // liveness info. Database details (name, size, SQLite version) are
  // intentionally omitted to avoid leaking metadata to anonymous callers.
  sendJson(res, 200, {
    ok: true,
    bridge: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    protocol: PROTOCOL_VERSION,
    authConfigured: !!config.bearer_token && config.bearer_token !== PLACEHOLDER_TOKEN,
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

function sendError(res, status, code, message, statementIndex) {
  const error = { code, message };
  if (statementIndex != null) error.statementIndex = statementIndex;
  sendJson(res, status, {
    ok: false,
    protocol: PROTOCOL_VERSION,
    error,
  });
}

// --- Misc helpers ------------------------------------------------------------

function round3(n) { return Math.round(n * 1000) / 1000; }

function parseBool(v, def) {
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return def;
}

function parseList(v) {
  if (!v) return null;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// --- Graceful shutdown -------------------------------------------------------

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[basepanel] received ${sig}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
