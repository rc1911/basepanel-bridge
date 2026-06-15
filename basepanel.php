<?php
declare(strict_types=1);

/**
 * Basepanel Bridge — single-file SQLite proxy for PHP.
 *
 * Drop this file onto your VPS next to your .sqlite database, set the
 * BEARER_TOKEN and DATABASE_PATH below, and point the Basepanel app at
 * its public URL.
 *
 *   https://basepanel.com
 *   https://github.com/basepanel/basepanel-bridge
 *
 * Requirements:
 *   - PHP 8.0+
 *   - PDO with the sqlite driver (almost always bundled with PHP)
 *
 * License: MIT
 */

// =============================================================================
//  CONFIG — edit these values, then upload this file to your server.
// =============================================================================

$config = [
    /**
     * REQUIRED. A long random secret. Anyone who knows this token can run
     * arbitrary SQL against your database, so treat it like a password.
     *
     * Generate one with:
     *   php -r "echo bin2hex(random_bytes(32));"
     */
    'bearer_token'    => 'REPLACE_ME_WITH_A_LONG_RANDOM_TOKEN',

    /**
     * Absolute path to the SQLite file you want to expose. By default this
     * looks for `database.sqlite` in the same folder as this script.
     */
    'database_path'   => __DIR__ . '/database.sqlite',

    /**
     * If true, the database is opened read-only and only SELECT / WITH /
     * EXPLAIN / PRAGMA / VALUES statements are accepted. Useful if you
     * only want Basepanel to read.
     */
    'read_only'       => false,

    /**
     * Reject plain-HTTP requests. Strongly recommended; only disable when
     * testing locally over loopback.
     */
    'require_https'   => true,

    /**
     * Peer addresses (REMOTE_ADDR) allowed to set X-Forwarded-* headers,
     * e.g. a load balancer or CDN in front of your web server. Forwarded
     * headers from any other peer are ignored, so they can't be spoofed
     * to bypass `require_https` or `allowed_ips`. If PHP runs directly
     * behind Apache/nginx on the same box you don't need to change this.
     */
    'trusted_proxies' => ['127.0.0.1', '::1'],

    /**
     * Optional IP allowlist (exact match against the client's address).
     * Leave empty to allow any IP that knows the bearer token.
     */
    'allowed_ips'     => [],

    /**
     * CORS origins. The Basepanel apps (iOS, iPadOS, Android, and Mac
     * Catalyst) all use native networking and ignore CORS entirely; this
     * only matters if you also call the bridge from a browser.
     */
    'allowed_origins' => ['*'],

    /**
     * Maximum POST body size. Increase if you need to run very large SQL.
     */
    'max_body_bytes'  => 4 * 1024 * 1024, // 4 MB

    /**
     * SQLite busy timeout in milliseconds (waits for locks to clear).
     */
    'busy_timeout_ms' => 5000,
];

// =============================================================================
//  IMPLEMENTATION — no edits required below.
// =============================================================================

const BRIDGE_NAME      = 'basepanel-bridge-php';
const BRIDGE_VERSION   = '1.0.0';
const PROTOCOL_VERSION = 1;
const PLACEHOLDER_TOKEN = 'REPLACE_ME_WITH_A_LONG_RANDOM_TOKEN';

if (ob_get_level() === 0) {
    ob_start();
}

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if ((error_reporting() & $severity) === 0) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

try {
    handle_request($config);
} catch (Throwable $e) {
    send_error(500, 'INTERNAL_ERROR', 'Unexpected error while handling request.');
}

// -----------------------------------------------------------------------------

function handle_request(array $config): void
{
    apply_cors($config['allowed_origins']);

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

    if ($method === 'OPTIONS') {
        http_response_code(204);
        return;
    }

    if (!extension_loaded('pdo_sqlite')) {
        send_error(500, 'PDO_SQLITE_MISSING', 'PHP extension pdo_sqlite is not enabled.');
    }

    if ($config['require_https'] && !is_https($config['trusted_proxies'])) {
        send_error(400, 'HTTPS_REQUIRED', 'This bridge must be served over HTTPS.');
    }

    if (!empty($config['allowed_ips']) && !in_array(client_ip($config['trusted_proxies']), $config['allowed_ips'], true)) {
        send_error(403, 'IP_FORBIDDEN', 'Client IP is not in the allowlist.');
    }

    if ($method === 'GET' || $method === 'HEAD') {
        send_info($config);
        return;
    }

    if ($method !== 'POST') {
        send_error(405, 'METHOD_NOT_ALLOWED', 'Only GET and POST are supported.');
    }

    if (!is_token_valid($config['bearer_token'])) {
        send_error(401, 'UNAUTHORIZED', 'Missing or invalid bearer token.');
    }

    $body    = read_body($config['max_body_bytes']);
    $payload = json_decode($body, true);
    if (!is_array($payload)) {
        send_error(400, 'INVALID_JSON', 'Request body must be a JSON object.');
    }

    $statements = normalize_statements($payload);
    $useTx      = array_key_exists('transaction', $payload)
        ? (bool) $payload['transaction']
        : count($statements) > 1;

    $pdo = open_database(
        $config['database_path'],
        $config['read_only'],
        $config['busy_timeout_ms']
    );

    $start   = microtime(true);
    $results = execute_statements($pdo, $statements, $useTx, $config['read_only']);
    $totalMs = (microtime(true) - $start) * 1000;

    send_json([
        'ok'            => true,
        'protocol'      => PROTOCOL_VERSION,
        'bridge'        => BRIDGE_NAME,
        'version'       => BRIDGE_VERSION,
        'sqliteVersion' => $pdo->query('SELECT sqlite_version()')->fetchColumn(),
        'totalTimeMs'   => round($totalMs, 3),
        'results'       => $results,
    ]);
}

// --- Request helpers ---------------------------------------------------------

function apply_cors(array $origins): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (in_array('*', $origins, true)) {
        header('Access-Control-Allow-Origin: *');
    } elseif ($origin !== '' && in_array($origin, $origins, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
    header('Access-Control-Max-Age: 86400');
}

function is_from_trusted_proxy(array $trustedProxies): bool
{
    $peer = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    return $peer !== '' && in_array($peer, $trustedProxies, true);
}

function is_https(array $trustedProxies): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443) {
        return true;
    }
    if (is_from_trusted_proxy($trustedProxies)) {
        // Take the last (right-most) entry: it's the one set by our own proxy.
        $parts = explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
        if (strtolower(trim((string) end($parts))) === 'https') {
            return true;
        }
    }
    return false;
}

function client_ip(array $trustedProxies): string
{
    if (is_from_trusted_proxy($trustedProxies)) {
        // Right-most X-Forwarded-For entry is appended by our trusted proxy;
        // anything left of it is client-supplied and spoofable.
        $parts = array_values(array_filter(array_map('trim',
            explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '')))));
        if (count($parts) > 0) {
            return $parts[count($parts) - 1];
        }
    }
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '');
}

function is_token_valid(string $expected): bool
{
    $header = $_SERVER['HTTP_AUTHORIZATION']
        ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
        ?? '';

    if (function_exists('apache_request_headers') && $header === '') {
        $headers = apache_request_headers();
        foreach ($headers as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $header = $value;
                break;
            }
        }
    }

    if (!preg_match('/^Bearer\s+(\S+)$/i', (string) $header, $m)) {
        return false;
    }
    if ($expected === '' || $expected === PLACEHOLDER_TOKEN) {
        return false;
    }
    // Hash both sides so the comparison is constant-length as well as
    // constant-time (hash_equals alone leaks the token's length).
    return hash_equals(hash('sha256', $expected), hash('sha256', $m[1]));
}

function read_body(int $maxBytes): string
{
    $declaredLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($declaredLength > $maxBytes) {
        send_error(413, 'BODY_TOO_LARGE', "Request body exceeds {$maxBytes} bytes.");
    }
    $body = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
    if ($body === false) {
        send_error(400, 'BODY_READ_ERROR', 'Could not read request body.');
    }
    if (strlen($body) > $maxBytes) {
        send_error(413, 'BODY_TOO_LARGE', "Request body exceeds {$maxBytes} bytes.");
    }
    return $body;
}

function normalize_statements(array $payload): array
{
    if (isset($payload['statements']) && is_array($payload['statements'])) {
        $list = $payload['statements'];
    } elseif (isset($payload['sql']) && is_string($payload['sql'])) {
        $list = [[
            'sql'    => $payload['sql'],
            'params' => $payload['params'] ?? [],
        ]];
    } else {
        send_error(400, 'INVALID_REQUEST', 'Provide a "sql" string or "statements" array.');
    }

    if (count($list) === 0) {
        send_error(400, 'EMPTY_REQUEST', 'No SQL statements were provided.');
    }

    $normalized = [];
    foreach ($list as $i => $entry) {
        if (!is_array($entry) || !isset($entry['sql']) || !is_string($entry['sql'])) {
            send_error(400, 'INVALID_STATEMENT', "Statement #{$i} must contain a 'sql' string.", $i);
        }
        $params = $entry['params'] ?? [];
        if (!is_array($params)) {
            send_error(400, 'INVALID_PARAMS', "Statement #{$i} 'params' must be an array.", $i);
        }
        $normalized[] = ['sql' => $entry['sql'], 'params' => $params];
    }
    return $normalized;
}

// --- Database ----------------------------------------------------------------

function open_database(string $path, bool $readOnly, int $busyMs): PDO
{
    if (!file_exists($path)) {
        send_error(500, 'DATABASE_NOT_FOUND', 'Database file does not exist on the server.');
    }
    if (!is_readable($path)) {
        send_error(500, 'DATABASE_UNREADABLE', 'Database file is not readable by the web server user.');
    }

    try {
        $pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_NUM,
        ]);
    } catch (PDOException $e) {
        send_error(500, 'DATABASE_OPEN_FAILED', 'Could not open the SQLite database.');
    }

    if ($busyMs > 0) {
        $pdo->exec('PRAGMA busy_timeout = ' . (int) $busyMs);
    }
    if ($readOnly) {
        $pdo->exec('PRAGMA query_only = 1');
    }
    return $pdo;
}

function execute_statements(PDO $pdo, array $statements, bool $useTx, bool $readOnly): array
{
    $results = [];
    if ($useTx) {
        $pdo->beginTransaction();
    }
    try {
        foreach ($statements as $i => $s) {
            if ($readOnly && !is_safe_read($s['sql'])) {
                send_error(403, 'READ_ONLY_VIOLATION', "Statement #{$i} is not allowed in read-only mode.", $i);
            }

            $started = microtime(true);
            try {
                $stmt = $pdo->prepare($s['sql']);
                bind_params($stmt, $s['params']);
                $stmt->execute();
            } catch (PDOException $e) {
                if ($useTx && $pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                send_error(400, 'SQL_ERROR', $e->getMessage(), $i);
            }
            $elapsedMs = (microtime(true) - $started) * 1000;

            if ($stmt->columnCount() > 0) {
                $columns  = [];
                $isBlobCol = [];
                for ($c = 0; $c < $stmt->columnCount(); $c++) {
                    $meta        = $stmt->getColumnMeta($c) ?: [];
                    $columns[]   = $meta['name'] ?? "col{$c}";
                    $declType    = strtoupper((string) ($meta['sqlite:decl_type'] ?? ''));
                    $isBlobCol[] = strpos($declType, 'BLOB') !== false;
                }
                $rawRows = $stmt->fetchAll(PDO::FETCH_NUM);
                $rows    = array_map(static function (array $row) use ($isBlobCol): array {
                    $encoded = [];
                    foreach ($row as $i => $v) {
                        $encoded[] = encode_value($v, $isBlobCol[$i] ?? false);
                    }
                    return $encoded;
                }, $rawRows);

                $results[] = [
                    'columns'         => $columns,
                    'rows'            => $rows,
                    'rowsAffected'    => 0,
                    'lastInsertRowid' => null,
                    'executionTimeMs' => round($elapsedMs, 3),
                ];
            } else {
                $lastId    = $pdo->lastInsertId();
                $lastIdInt = ($lastId !== '' && $lastId !== false && $lastId !== '0') ? (int) $lastId : null;
                $results[] = [
                    'columns'         => [],
                    'rows'            => [],
                    'rowsAffected'    => $stmt->rowCount(),
                    'lastInsertRowid' => $lastIdInt,
                    'executionTimeMs' => round($elapsedMs, 3),
                ];
            }
            $stmt->closeCursor();
        }

        if ($useTx) {
            $pdo->commit();
        }
    } catch (Throwable $e) {
        if ($useTx && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return $results;
}

function bind_params(PDOStatement $stmt, array $params): void
{
    $isAssoc = !array_is_list($params);
    foreach ($params as $key => $value) {
        $param = $isAssoc ? (is_string($key) && $key[0] !== ':' ? ':' . $key : $key) : ($key + 1);
        [$decoded, $type] = decode_value($value);
        $stmt->bindValue($param, $decoded, $type);
    }
}

function decode_value($value): array
{
    if (is_array($value) && isset($value['$type']) && $value['$type'] === 'bytes' && isset($value['base64'])) {
        $bytes = base64_decode((string) $value['base64'], true);
        if ($bytes === false) {
            $bytes = '';
        }
        return [$bytes, PDO::PARAM_LOB];
    }
    if (is_bool($value)) {
        return [$value ? 1 : 0, PDO::PARAM_INT];
    }
    if (is_int($value)) {
        return [$value, PDO::PARAM_INT];
    }
    if ($value === null) {
        return [null, PDO::PARAM_NULL];
    }
    if (is_float($value)) {
        return [$value, PDO::PARAM_STR];
    }
    return [(string) $value, PDO::PARAM_STR];
}

function encode_value($value, bool $isBlobColumn = false)
{
    if (is_resource($value)) {
        $value = stream_get_contents($value);
    }
    if (is_string($value)) {
        if ($isBlobColumn || !is_valid_utf8($value)) {
            return ['$type' => 'bytes', 'base64' => base64_encode($value)];
        }
    }
    return $value;
}

function is_valid_utf8(string $s): bool
{
    if (function_exists('mb_check_encoding')) {
        return mb_check_encoding($s, 'UTF-8');
    }
    return (bool) preg_match('//u', $s);
}

function is_safe_read(string $sql): bool
{
    $stripped = preg_replace('#/\*.*?\*/#s', ' ', $sql) ?? $sql;
    $stripped = preg_replace('/--[^\n]*/', ' ', $stripped) ?? $stripped;
    $stripped = ltrim($stripped);
    return (bool) preg_match('/^(SELECT|WITH|EXPLAIN|PRAGMA|VALUES)\b/i', $stripped);
}

// --- Responses ---------------------------------------------------------------

function send_info(array $config): void
{
    // This endpoint is unauthenticated, so it returns only non-sensitive
    // liveness info. Database details (name, size, SQLite version) are
    // intentionally omitted to avoid leaking metadata to anonymous callers.
    send_json([
        'ok'             => true,
        'bridge'         => BRIDGE_NAME,
        'version'        => BRIDGE_VERSION,
        'protocol'       => PROTOCOL_VERSION,
        'authConfigured' => $config['bearer_token'] !== '' && $config['bearer_token'] !== PLACEHOLDER_TOKEN,
    ]);
}

function send_json($data, int $status = 200): void
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
    }
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    if (ob_get_level() > 0) {
        ob_end_flush();
    }
    exit;
}

function send_error(int $status, string $code, string $message, ?int $statementIndex = null): void
{
    $error = [
        'code'    => $code,
        'message' => $message,
    ];
    if ($statementIndex !== null) {
        $error['statementIndex'] = $statementIndex;
    }
    send_json([
        'ok'       => false,
        'protocol' => PROTOCOL_VERSION,
        'error'    => $error,
    ], $status);
}
