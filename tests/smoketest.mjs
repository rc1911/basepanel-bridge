// Smoke tests for the Basepanel Bridge. Validates that all three
// implementations (php / node / python) speak the same wire protocol.
//
//   node tests/smoketest.mjs              # default: node
//   node tests/smoketest.mjs --runtime=node
//   node tests/smoketest.mjs --runtime=python
//   node tests/smoketest.mjs --runtime=php
//   node tests/smoketest.mjs --runtime=all
//
// Requires Node.js 22.5+, plus whichever target runtimes you pick.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const runtimeArg = (args.find((a) => a.startsWith('--runtime=')) || '--runtime=node').split('=')[1];
const RUNTIMES = runtimeArg === 'all' ? ['node', 'python', 'php'] : [runtimeArg];

let totalFailures = 0;

for (const runtime of RUNTIMES) {
  console.log(`\n=== ${runtime.toUpperCase()} ===`);
  const dbPath = await freshDatabase();
  let proc;
  try {
    proc = await startBridge(runtime, dbPath);
    totalFailures += await runTests();
  } finally {
    if (proc) {
      proc.kill('SIGTERM');
      await sleep(300);
      if (!proc.killed) proc.kill('SIGKILL');
    }
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
}

console.log(totalFailures === 0
  ? `\nall good across ${RUNTIMES.join(', ')}`
  : `\n${totalFailures} failure(s)`);
process.exit(totalFailures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

async function freshDatabase() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basepanel-smoke-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB, score REAL);
    INSERT INTO users (name, avatar, score) VALUES ('Alice', x'48656c6c6f', 9.5);
    INSERT INTO users (name, avatar, score) VALUES ('Bob', NULL, 7.25);
  `);
  db.close();
  return dbPath;
}

async function startBridge(runtime, dbPath) {
  let cmd;
  let proc;
  const env = {
    ...process.env,
    BASEPANEL_BEARER_TOKEN: TOKEN,
    BASEPANEL_DATABASE_PATH: dbPath,
    BASEPANEL_REQUIRE_HTTPS: 'false',
    BASEPANEL_PORT: String(PORT),
    BASEPANEL_HOST: '127.0.0.1',
  };

  if (runtime === 'node') {
    proc = spawn(process.execPath, [path.join(ROOT, 'basepanel.js')], { env, stdio: 'pipe' });
  } else if (runtime === 'python') {
    proc = spawn('python3', [path.join(ROOT, 'basepanel.py')], { env, stdio: 'pipe' });
  } else if (runtime === 'php') {
    // PHP doesn't read env vars natively (the file uses constants), so we
    // copy and patch on the fly for testing.
    const tmpScript = path.join(path.dirname(dbPath), 'basepanel-test.php');
    const src = fs.readFileSync(path.join(ROOT, 'basepanel.php'), 'utf8')
      .replace("'REPLACE_ME_WITH_A_LONG_RANDOM_TOKEN'", `'${TOKEN}'`)
      .replace("__DIR__ . '/database.sqlite'", JSON.stringify(dbPath))
      .replace("'require_https'   => true", "'require_https'   => false");
    fs.writeFileSync(tmpScript, src);
    proc = spawn('php', ['-S', `127.0.0.1:${PORT}`, tmpScript], { env, stdio: 'pipe' });
  } else {
    throw new Error(`unknown runtime: ${runtime}`);
  }

  proc.stdout.on('data', (d) => process.stderr.write(`[${runtime}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[${runtime}] ${d}`));

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return proc;
    } catch (_) { /* not ready */ }
  }
  throw new Error(`bridge ${runtime} failed to start`);
}

async function http(method, opts = {}) {
  const res = await fetch(BASE + (opts.path || '/'), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* */ }
  return { status: res.status, body };
}

async function runTests() {
  const failures = [];
  const cases = [
    ['GET / returns info, no auth required', async () => {
      const r = await http('GET', { auth: false });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.protocol, 1);
      assert.equal(r.body.authConfigured, true);
      assert.ok(r.body.bridge.startsWith('basepanel-bridge-'));
      assert.equal(r.body.database, undefined);
    }],
    ['POST without token is rejected', async () => {
      const r = await http('POST', { auth: false, body: { sql: 'SELECT 1' } });
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'UNAUTHORIZED');
    }],
    ['POST with wrong token is rejected', async () => {
      const r = await http('POST', { headers: { Authorization: 'Bearer wrong' }, body: { sql: 'SELECT 1' } });
      assert.equal(r.status, 401);
    }],
    ['POST simple SELECT', async () => {
      const r = await http('POST', { body: { sql: 'SELECT 1 + 1 AS two' } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.results[0].columns, ['two']);
      assert.deepEqual(r.body.results[0].rows, [[2]]);
    }],
    ['POST SELECT with positional params', async () => {
      const r = await http('POST', {
        body: { sql: 'SELECT id, name, score FROM users WHERE id = ?', params: [1] },
      });
      assert.equal(r.status, 200);
      const row = r.body.results[0];
      assert.deepEqual(row.columns, ['id', 'name', 'score']);
      assert.deepEqual(row.rows, [[1, 'Alice', 9.5]]);
    }],
    ['SELECT BLOB returns base64-tagged value', async () => {
      const r = await http('POST', { body: { sql: 'SELECT avatar FROM users WHERE id = 1' } });
      assert.equal(r.status, 200);
      const v = r.body.results[0].rows[0][0];
      assert.equal(v.$type, 'bytes');
      assert.equal(Buffer.from(v.base64, 'base64').toString('utf8'), 'Hello');
    }],
    ['Round-trip BLOB via $bytes param', async () => {
      const original = Buffer.from('basepanel rocks');
      const ins = await http('POST', {
        body: {
          sql: "INSERT INTO users (name, avatar, score) VALUES ('Carol', ?, 1.0)",
          params: [{ $type: 'bytes', base64: original.toString('base64') }],
        },
      });
      assert.equal(ins.status, 200);
      const id = ins.body.results[0].lastInsertRowid;
      assert.ok(id > 0);
      const sel = await http('POST', { body: { sql: 'SELECT avatar FROM users WHERE id = ?', params: [id] } });
      const back = Buffer.from(sel.body.results[0].rows[0][0].base64, 'base64');
      assert.equal(back.toString('utf8'), 'basepanel rocks');
    }],
    ['Multi-statement transaction commit', async () => {
      const r = await http('POST', {
        body: {
          statements: [
            { sql: "INSERT INTO users (name, score) VALUES ('Dan', 5)" },
            { sql: "INSERT INTO users (name, score) VALUES ('Eve', 6)" },
          ],
        },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.results.length, 2);
      assert.equal(r.body.results[0].rowsAffected, 1);
    }],
    ['Multi-statement transaction rollback on error', async () => {
      const before = await http('POST', { body: { sql: 'SELECT COUNT(*) AS c FROM users' } });
      const beforeCount = before.body.results[0].rows[0][0];
      const r = await http('POST', {
        body: {
          statements: [
            { sql: "INSERT INTO users (name, score) VALUES ('Frank', 1)" },
            { sql: 'NOT VALID SQL' },
          ],
        },
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'SQL_ERROR');
      assert.equal(r.body.error.statementIndex, 1);
      const after = await http('POST', { body: { sql: 'SELECT COUNT(*) AS c FROM users' } });
      assert.equal(after.body.results[0].rows[0][0], beforeCount, 'tx should have rolled back');
    }],
    ['Invalid JSON returns INVALID_JSON', async () => {
      const res = await fetch(BASE + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: 'not json',
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'INVALID_JSON');
    }],
    ['Empty statements array', async () => {
      const r = await http('POST', { body: { statements: [] } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'EMPTY_REQUEST');
    }],
    ['PRAGMA returns rows', async () => {
      const r = await http('POST', { body: { sql: 'PRAGMA table_info(users)' } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.results[0].columns, ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk']);
      assert.ok(r.body.results[0].rows.length >= 4);
    }],
    ['OPTIONS preflight', async () => {
      const res = await fetch(BASE + '/', { method: 'OPTIONS' });
      assert.equal(res.status, 204);
      assert.ok(res.headers.get('access-control-allow-methods'));
    }],
  ];

  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL ${name}\n       ${err.message}`);
    }
  }
  return failures.length;
}
