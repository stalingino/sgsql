# Sidecar Rust Migration Plan

Rewrite `sidecar/` (Bun/TypeScript, ~2,100 LOC) as a Rust binary using **axum + tokio + sqlx**, keeping the HTTP/WS contract byte-compatible so the React frontend and `src-tauri` need zero (or near-zero) changes.

## 1. Current state (what must be reproduced)

The sidecar is a standalone HTTP + WebSocket server on port `45821` (overridable via `--port=`), compiled by `bun build --compile` into `src-tauri/binaries/dbsidecar-aarch64-apple-darwin`, registered as Tauri `externalBin`, spawned/killed by `src-tauri/src/lib.rs`, and codesigned with `sidecar-entitlements.plist`.

### HTTP/WS contract (frontend-facing, must not change)

| Route | Method | Behavior |
|---|---|---|
| `/health` | GET | liveness + pool size |
| `/connections/test` | POST | one-shot connect probe, returns `{ok, latency}` or `{ok:false, error}` (always HTTP 200) |
| `/connections/open` | POST | open + pool a connection, returns `{connectionId, serverVersion}` |
| `/connections/close` | POST | `{ok:true}` / 404 |
| `/connections/ensure` | POST | idle health check + auto-reconnect, returns `{ok, reconnected}` |
| `/connections/reload` | POST | force reconnect |
| `/query` | POST | arbitrary SQL; SELECT-ish → `{columns, rows[][], rowCount, query, duration}`, else `{affectedRows, query, duration}` |
| `/cancel` | POST | kill running query (MySQL `KILL QUERY <threadId>` via a second connection; Postgres `pg_cancel_backend(pid)`; SQLite no-op) |
| `/schema/:connId/:action` | GET | actions: `databases`, `catalog`, `schemas`, `tables`, `columns`, `indexes`, `fks`, `ddl`, `artifacts`, `rows` (params: `db`, `schema`, `table`, `limit`, `offset`, `orderBy`, `where`) |
| `/schema/:connId/apply` | POST | DDL batch: Postgres in one transaction, SQLite transaction + optional `PRAGMA foreign_keys` toggle + `foreign_key_check`, MySQL sequential with committed-count in error message; max 100 statements |
| `/query-log` | WS | messages `{type:"snapshot", entries}`, `{type:"entry", entry}`, `{type:"cleared"}`; client sends `"clear"` |

Cross-cutting behaviors:

- **CORS**: permissive headers on every response (Tauri webview origin).
- **`_connection` envelope**: any response after an auto-reconnect gains `_connection: {connectionId, reconnected: true}`.
- **Auto-reconnect**: on connection-class errors (`isConnectionError` string heuristics in `sidecar/lib/pool.ts:79`), reconnect once and retry the operation; concurrent reconnects for the same id are deduplicated.
- **Idle health check**: connections idle > 30 s get a bounded (3 s) `SELECT 1`/`ping` before real work (`ensureConnectionAlive`).
- **Query tracing**: every statement on every driver is logged (query text, duration, rowCount/affectedRows, error, cancelled flag) into a 1,000-entry ring buffer broadcast over `/query-log` (`queryTrace.ts` Proxy instrumentation + `queryLogHub.ts`).
- **Friendly errors**: `friendlyError.ts` maps error-chain messages/codes to human messages; SSH-prefixed messages pass through untouched; open/test failures over SSH get the "SSH tunnel established, but the database …" wrapper.
- **SSH tunnels**: `sshTunnel.ts` shells out to system `ssh -N -T -L …` with `ExitOnForwardFailure`, keepalives, `StrictHostKeyChecking=accept-new`; password auth via a temp `SSH_ASKPASS` script + env var; inline private keys written to a temp `0600` file; readiness = TCP probe loop on the local port with a 12 s deadline; stderr captured for error normalization.

### Driver-specific semantics worth noting

- Postgres uses `postgres.js` with `max: 4` (a small pool); MySQL is a **single** `mysql2` connection (its `threadId` is what `/cancel` kills); SQLite is synchronous `bun:sqlite`.
- `/query` classifies with `^\s*(SELECT|SHOW|DESCRIBE|EXPLAIN)/i` and switches DB context first (MySQL `USE`, Postgres no-op, SQLite no-op).
- `rows` action validates `orderBy` against the real column list (case-insensitive) and clamps `limit` to 1–1000; `where` is passed through raw (trusted local caller).
- Postgres DDL generation (`getTableDdl`) reassembles CREATE TABLE from `pg_catalog` plus indexes, triggers, comments, grants, partition keys, reloptions, tablespace.

## 2. Target stack

| Concern | Crate | Notes |
|---|---|---|
| HTTP + WS | `axum` (ws feature) | routing, extractors, WS upgrade for `/query-log` |
| Runtime | `tokio` (full) | |
| CORS | `tower-http` `CorsLayer::permissive()` | replaces hand-rolled headers |
| DB drivers | `sqlx` with `postgres`, `mysql`, `sqlite`, `runtime-tokio`, `tls-rustls` | one async API over all three dialects; no compile-time query checking (all SQL here is dynamic) |
| JSON | `serde` / `serde_json` | |
| SSH | `tokio::process::Command` | keep shelling out to system `ssh` — same args, same askpass trick; do **not** adopt `russh` in phase 1 |
| Temp files | `tempfile` | askpass script, inline private keys |
| Logging | `tracing` + `tracing-subscriber` | stdout, picked up by the existing Tauri log forwarding |
| Errors | `thiserror` | typed `SidecarError` with a `friendly()` renderer |

Alternative considered: `tokio-postgres` (first-class `CancelToken`) + `mysql_async` + `rusqlite`. Rejected for phase 1 — three different APIs triples the surface of `schema.rs`; sqlx's uniform `Row`/`Executor` maps cleanly onto the existing `PoolEntry` switch-per-dialect style. Cancellation is solvable in sqlx (see §4.5).

### Where the code lives

Convert `src-tauri/` into a Cargo workspace:

```
src-tauri/
  Cargo.toml            # [workspace] members = ["app", "sidecar"]
  app/                  # existing tauri app crate (moved)
  sidecar/              # new crate → binary `dbsidecar`
    src/
      main.rs           # arg parsing, router, serve
      routes/{health,connections,schema,query,cancel,apply}.rs
      pool.rs           # connection registry + reconnect + ensure
      ssh.rs            # tunnel management
      trace.rs          # traced_query wrapper + ring buffer + broadcast
      value.rs          # DB value → serde_json::Value per dialect
      error.rs          # SidecarError + friendly()
      types.rs          # ConnectionProfile etc.
```

Keeping the sidecar a **separate binary** (not folded into the Tauri process) is deliberate for phase 1: the `externalBin` spawn/kill/logging machinery in `lib.rs`, the dev-mode "already running on 45821" check, and crash isolation from the UI all keep working unchanged. Folding it in-process (axum server on a tokio task inside the app) is a possible phase 2 that would delete the spawn/codesign machinery — decide after parity is proven.

## 3. Module-by-module mapping

| TypeScript | Rust | Notes |
|---|---|---|
| `index.ts` (router, CORS, port arg) | `main.rs` + axum `Router` | `--port=` parsing identical; `SO_REUSEPORT` via `socket2` if quick-restart behavior matters |
| `lib/types.ts` `ConnectionProfile` | `types.rs` with `#[serde(rename_all = "camelCase")]` | field names must match the frontend JSON exactly |
| `lib/pool.ts` | `pool.rs`: `RwLock<HashMap<String, Arc<PoolRecord>>>` | `PoolEntry` enum { `Postgres(PgPool)`, `MySql(MySqlConnRecord)`, `Sqlite(SqlitePool)` }; reconnect dedup via a `Mutex<HashMap<String, Shared<future>>>` or a per-id `tokio::sync::Mutex`; preserve the "never delete a replacement opened during async close" guard (`pool.ts:63`) |
| `isConnectionError` | `error.rs::is_connection_error` | sqlx gives structured `sqlx::Error::Io` / `PoolTimedOut` / `Database(code)` — match variants first, fall back to the string heuristics for parity |
| `lib/friendlyError.ts` | `error.rs::friendly` | same message strings verbatim (frontend may display them; tests assert them) |
| `lib/sshTunnel.ts` | `ssh.rs` | same ssh argv; `waitForPort` = `TcpStream::connect` loop with 12 s deadline; stderr tail capped at 16 KB; `SshTunnel` holds the `Child` and kills on `close()`/`Drop` |
| `lib/queryTrace.ts` (Proxy magic) | `trace.rs::traced(conn_id, db, sql, fut)` | Rust can't monkey-patch drivers; instead every DB call in `schema.rs`/`query.rs` goes through one explicit wrapper. This is a *simplification*: ~10 call-site helpers instead of three Proxy instrumenters. Same `QueryTraceEntry` JSON shape incl. `cancelled`/`cancelDetail` regex |
| `lib/queryLogHub.ts` | `trace.rs`: `Mutex<VecDeque<Entry>>` (cap 1000) + `tokio::sync::broadcast` | WS handler sends snapshot on connect, forwards broadcast, handles `"clear"` |
| `routes/connections.ts` | `routes/connections.rs` | `/test` always returns HTTP 200 with `{ok:false,error}` on failure — preserve |
| `routes/schema.ts` | `routes/{schema,query,cancel,apply}.rs` | port every SQL string **verbatim**; this file is 60% of the work |
| `routes/health.ts` | `routes/health.rs` | |

## 4. The hard parts (call them out before they bite)

### 4.1 Dynamic value → JSON (`value.rs`) — highest-risk module
`postgres.js`/`mysql2`/`bun:sqlite` decode every column type to a JS value for free; JSON.stringify defines today's wire format. In Rust you must write an explicit `Row → Vec<serde_json::Value>` decoder per dialect handling at minimum: ints (incl. `i64`/`u64` beyond JS-safe range — check what the frontend does with `postgres.js` bigints today and match), floats, `NUMERIC`/`DECIMAL` (postgres.js returns strings — match), bool, text, bytea/blob (match current base64/`Buffer` JSON form), date/time/timestamp/timestamptz (**postgres.js returns JS `Date` → ISO string with `Z`; mysql2 similar — serialization must match exactly or every date cell in the UI changes**), JSON/JSONB (nested value vs string), UUID, enums, arrays, NULL. Budget real time here and drive it with golden tests (§6). Unknown/exotic types: fall back to text cast, log a warning.

### 4.2 MySQL cancel needs the thread id
Today MySQL is one `mysql2` connection whose `threadId` is killed from a second short-lived connection. sqlx pools hide connection identity. Plan: MySQL uses a `MySqlPool` with `max_connections(1)` (matches today's single-connection serialization) and an `after_connect` hook that runs `SELECT CONNECTION_ID()` and stores it in the pool record. `/cancel` opens a throwaway connection (same host/credentials, no db) and issues `KILL QUERY <id>` — same as today, including the SSH-tunnel host if present (note: today's killer uses `profile.host` directly, which is arguably a bug under SSH tunnels; fix it in the rewrite and note the change).

### 4.3 Postgres cancel
Mirror the same pattern: `after_connect` hook captures `pg_backend_pid()` per connection; `/cancel` runs `SELECT pg_cancel_backend($1)` from a separate short-lived connection. (Today's version issues `pg_backend_pid()` through the busy pool at cancel time, which can block behind the very query being cancelled — the rewrite's hook approach is strictly better; keep `max_connections(4)` as today so there's usually a free conn anyway.)

### 4.4 Postgres "pool" vs single connection semantics
`postgres.js max:4` means today's PG queries can interleave. `PgPoolOptions::max_connections(4)` reproduces this. `SET`-style session state is not used (switchDb is a no-op for PG), so pooling is safe.

### 4.5 Statement execution differences
- `postgres.js` `.unsafe()` runs simple-protocol multi-statement strings in some cases; sqlx prepares single statements. Audit whether the frontend ever sends multi-statement SQL to `/query` (the SQL editor might). If yes: use sqlx's `raw_sql`/`Executor::execute_many` or split statements; decide and test explicitly.
- MySQL `multipleStatements` is off in mysql2 by default → single statement; keep it that way.
- SQLite `apply` uses a real transaction + `PRAGMA foreign_keys OFF/ON` outside it; PRAGMA is per-connection, so pin apply to one pooled connection (`pool.acquire()` held across the whole batch).

### 4.6 SQLite is now async-wrapped
`sqlx::SqlitePool` (or a `spawn_blocking` + `rusqlite` fallback if sqlx's SQLite type coverage disappoints in golden tests). Open with `SqliteConnectOptions::new().filename(...).create_if_missing(false)` — today a missing file errors at `/connections/test` with `File not found: <path>`; reproduce that exact message via an explicit existence check.

## 5. Phases

**Phase 0 — Contract harness (do this first, ~small)**
Stand up docker-compose Postgres + MySQL + a fixture SQLite file with a "kitchen sink" schema (every common type, enums, arrays, JSON, FKs, composite indexes, views, triggers, comments, partitioned table). Write a script that replays a canned request list against the **Bun** sidecar and snapshots every JSON response → `tests/golden/`. These snapshots are the acceptance criteria for the whole migration.

**Phase 1 — Scaffold**
Workspace conversion; `dbsidecar` crate; axum server with `--port=`, CORS layer, request logging, `/health`. CI builds it.

**Phase 2 — Types, errors, SSH**
`types.rs`, `error.rs` (friendly strings copied verbatim + unit tests ported from `tests/friendlyError.test.ts`), `ssh.rs` (manual test against a real SSH host; unit-test arg construction and failure normalization).

**Phase 3 — Pool + connection routes**
`pool.rs` with open/test/close/ensure/reload for all three dialects, reconnect dedup, idle checks, `_connection` envelope. Port `tests/pool.test.ts` semantics (close-vs-replacement race) as Rust tests.

**Phase 4 — Value decoding + `/query` + `/cancel`**
`value.rs` driven by golden tests until byte-identical (or consciously-documented deltas). Then `/query` incl. reconnect-retry path, `switchDb`, duration field; `/cancel` per §4.2/4.3.

**Phase 5 — Introspection + apply**
Port all `getX` functions with SQL verbatim; `apply` transaction semantics per dialect (port `tests/schemaApply.test.ts`, `schemaCatalog.test.ts`, `schemaDdl.test.ts` scenarios). Largest phase; slice by action, validating each against golden snapshots.

**Phase 6 — Query log + WS**
`trace.rs`, wire `traced()` through every DB call site, WS endpoint with snapshot/entry/cleared protocol. Verify in the app's query-log UI.

**Phase 7 — Build & release integration**
- Replace `sidecar:build` in `package.json` with: `cargo build --release -p dbsidecar --target aarch64-apple-darwin && cp target/.../dbsidecar src-tauri/binaries/dbsidecar-aarch64-apple-darwin && codesign …`.
- Entitlements: Bun needed JIT entitlements (`sidecar-entitlements.plist`); a Rust binary likely needs only network client + (if hardened runtime) nothing exotic — trim the plist, verify notarization still passes (see RELEASE_CI_NOTES.md history; test on CI early, actool/signing has bitten this repo before).
- Dev workflow: `cargo run -p dbsidecar` replaces `bun run sidecar/index.ts`; the lib.rs port-45821 dev check keeps working.
- Update `.github/workflows/release.yml` (add Rust target/cache; Bun stays for the Vite frontend build).

**Phase 8 — Cutover & cleanup**
Ship one release with the Rust sidecar behind manual QA against the golden suite + real-world connections (incl. SSH). Then delete `sidecar/`, its bun tests (ported), and `postgres`/`mysql2` from `package.json`.

## 6. Testing strategy

1. **Golden contract tests (primary)**: same request sequence → both sidecars → diff JSON (ignore `duration`, timestamps). Run in CI against dockerized PG 15/16 + MySQL 8 + SQLite fixture.
2. **Rust unit tests**: friendly-error mapping, `is_connection_error`, orderBy validation/limit clamping, identifier quoting, pool close-race, ssh arg construction, ring-buffer/broadcast.
3. **Integration**: kill-query test (long `pg_sleep`/`SLEEP` then `/cancel`), reconnect test (restart the docker DB mid-session, assert `_connection.reconnected`), SSH tunnel against a local sshd container.
4. **Manual app QA checklist**: connect each dialect (± SSH, ± SSL), browse schema, view rows with sort/filter, run queries incl. errors, cancel a long query, apply DDL, watch query log, sleep/wake laptop → auto-reconnect.

## 7. Risks & open questions

| Risk | Severity | Mitigation |
|---|---|---|
| JSON value fidelity (dates, decimals, bigints, bytea, jsonb) | **High** | Phase 0 golden tests before writing `value.rs`; enumerate deltas, fix frontend only where a delta is deliberate |
| Multi-statement SQL in `/query` | Medium | Audit frontend SQL editor behavior first (Phase 0) |
| sqlx SQLite type quirks | Medium | `rusqlite` + `spawn_blocking` fallback is a contained swap behind `PoolEntry::Sqlite` |
| Codesign/notarization of the new binary | Medium | Test in CI in Phase 7 week 1, not at release time |
| MySQL cancel thread-id under SSH tunnel | Low | Fixed by design (§4.2); note behavior change |
| `where` param remains raw SQL passthrough | — | Unchanged by design (local trusted caller), don't "fix" silently |

Open questions to settle during Phase 0:
1. Does any frontend code depend on `postgres.js`-specific value formats (e.g. `Date` objects serialized pre-stringify, bigint-as-number)? Check `src/` consumers of `/query` and `rows`.
2. Is Windows/Linux support planned? (`sidecar:build` is aarch64-macos only today; Rust makes cross-target trivial — bake the target triple matrix into Phase 7 if so.)
3. Fold into the Tauri process later (phase 2 option in §2) or keep the separate binary permanently?

## 8. Rough effort

| Phase | Estimate |
|---|---|
| 0 harness | 1–2 days |
| 1–3 scaffold/pool/ssh | 3–4 days |
| 4 values + query + cancel | 3–5 days (value.rs dominates) |
| 5 introspection + apply | 4–6 days |
| 6 query log | 1 day |
| 7 build/CI/signing | 1–2 days |
| 8 QA + cutover | 2–3 days |

Total: roughly **3–4 weeks** of focused work for full parity, with the golden-test harness as the safety net throughout.
