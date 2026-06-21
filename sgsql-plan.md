# sgsql — Stupidly Good SQL
### *"A SQL client worth using."*
#### Full Build Plan — Phased

---

## Project Decisions

|                     |                                                      |
|---------------------|------------------------------------------------------|
| **Name**            | sgsql                                                |
| **Full name**       | Stupidly Good SQL                                    |
| **Tagline**         | A SQL client worth using                             |
| **Repo**            | `sgsql`                                              |
| **Initial version** | `0.1.0`                                              |
| **License**         | TBD — MIT (open) or BSL (open personal / paid teams) |
| **App icon**        | A clean, flat coral-toned database stack with a magnifying glass inspecting a grid, set on a soft white rounded background.                   |

---

## Stack Overview

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 2.x (Rust) |
| DB backend | Bun sidecar (`Bun.SQL`) |
| Frontend | React 19 + TypeScript |
| SQL editor | Monaco Editor |
| Data grid | AG Grid Community |
| Styling | Tailwind CSS v4 |
| State | Zustand |
| Connection storage | `tauri-plugin-store` (encrypted) |
| IPC | HTTP over localhost (sidecar) |

---

## Phase 1 — Project Scaffold & Sidecar Wiring

**Goal**: Get a Tauri window that can spawn a Bun process and talk to it.

### 1.1 — Init the monorepo

```
/
├── src-tauri/          # Rust/Tauri shell
├── src/                # React frontend
└── sidecar/            # Bun HTTP server
    ├── index.ts
    ├── routes/
    └── lib/
```

```bash
bun create tauri@latest
# choose React + TypeScript frontend
```

### 1.2 — Build the Bun sidecar

Create `sidecar/index.ts` — a minimal HTTP server using `Bun.serve()`:

```ts
const server = Bun.serve({
  port: 7521,
  async fetch(req) {
    const url = new URL(req.url);
    // route dispatch here
    return new Response("not found", { status: 404 });
  },
});

console.log(`Sidecar listening on ${server.port}`);
```

Compile it:
```bash
bun build --compile sidecar/index.ts --outfile src-tauri/binaries/dbsidecar-x86_64-apple-darwin
```

Naming must match Tauri's sidecar convention: `{name}-{target-triple}`.

### 1.3 — Register the sidecar in Tauri

`src-tauri/tauri.conf.json`:
```json
{
  "bundle": {
    "externalBin": ["binaries/dbsidecar"]
  },
  "security": {
    "csp": "default-src 'self'; connect-src 'self' http://localhost:7521"
  }
}
```

`src-tauri/capabilities/default.json` — add shell permission:
```json
{
  "permissions": ["shell:allow-execute", "shell:allow-kill"]
}
```

### 1.4 — Sidecar lifecycle in Rust

`src-tauri/src/main.rs`:

```rust
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let sidecar = app.shell().sidecar("dbsidecar").unwrap();
            let (_rx, _child) = sidecar.spawn().expect("Failed to spawn sidecar");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running app");
}
```

Store the child handle in `app.manage()` so you can kill it on window close.

### 1.5 — Port conflict handling

On sidecar startup, check if port 7521 is already in use and either kill the old process or increment the port. Pass the chosen port back to the frontend via a Tauri command or a startup file.

### Deliverables
- [ ] Tauri window opens
- [ ] Bun sidecar spawns and is reachable at `localhost:7521`
- [ ] Sidecar shuts down cleanly when window closes
- [ ] CSP allows `localhost:7521` fetch calls

---

## Phase 2 — Connection Manager

**Goal**: Save, load, test, and delete named connection profiles. No actual DB querying yet.

### 2.1 — Connection profile schema

```ts
// sidecar/lib/types.ts
export interface ConnectionProfile {
  id: string;           // nanoid
  name: string;         // "Dvara Prod"
  type: "postgres" | "mysql" | "sqlite";
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;     // stored encrypted via tauri-plugin-store
  ssl: boolean;
  color: string;        // tab accent color, like TablePlus
}
```

### 2.2 — Storage via tauri-plugin-store

Profiles are stored encrypted on disk. Sensitive fields (password) are encrypted at rest.

Frontend calls:
```ts
import { load } from "@tauri-apps/plugin-store";

const store = await load("connections.json", { autoSave: true });
await store.set("connections", profiles);
const profiles = await store.get<ConnectionProfile[]>("connections");
```

### 2.3 — Sidecar: test connection endpoint

`POST /connections/test`

```ts
// sidecar/routes/connections.ts
import { SQL } from "bun";

export async function testConnection(profile: ConnectionProfile) {
  const sql = buildSQLClient(profile);
  try {
    await sql`SELECT 1`;
    await sql.end();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function buildSQLClient(p: ConnectionProfile) {
  if (p.type === "sqlite") return new SQL(p.database);
  return new SQL({
    host: p.host,
    port: p.port,
    database: p.database,
    username: p.username,
    password: p.password,
  });
}
```

### 2.4 — Frontend: Connection sidebar UI

- List of saved connections with color dot + db type icon
- "New Connection" modal form
- Test button that hits `/connections/test`
- Double-click to open a connection (triggers Phase 3)

### Deliverables
- [ ] Add/edit/delete connection profiles
- [ ] Profiles persist across app restarts
- [ ] Test connection gives green/red feedback with error message
- [ ] Passwords never logged or sent unencrypted

---

## Phase 3 — Schema Browser

**Goal**: Once connected, show the left-panel tree: databases → schemas → tables/views → columns.

### 3.1 — Active connection pool in sidecar

Each opened connection gets a `SQL` client instance stored in a Map keyed by `connectionId`. This avoids reconnecting on every query.

```ts
// sidecar/lib/pool.ts
const pool = new Map<string, SQL>();

export function getClient(id: string) {
  return pool.get(id);
}
export function setClient(id: string, sql: SQL) {
  pool.set(id, sql);
}
export async function closeClient(id: string) {
  await pool.get(id)?.end();
  pool.delete(id);
}
```

### 3.2 — Introspection queries per dialect

**PostgreSQL:**
```ts
// Tables + views
const tables = await sql`
  SELECT table_name, table_type
  FROM information_schema.tables
  WHERE table_schema = ${schema}
  ORDER BY table_name
`;

// Columns
const columns = await sql`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = ${schema} AND table_name = ${table}
  ORDER BY ordinal_position
`;

// Indexes
const indexes = await sql`
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = ${schema} AND tablename = ${table}
`;

// Foreign keys
const fks = await sql`
  SELECT
    kcu.column_name,
    ccu.table_name AS foreign_table,
    ccu.column_name AS foreign_column
  FROM information_schema.table_constraints AS tc
  JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name = ${table}
`;
```

**MySQL:**
```ts
const tables = await sql`SHOW FULL TABLES FROM ${sql(database)}`;
const columns = await sql`DESCRIBE ${sql(database + "." + table)}`;
```

**SQLite:**
```ts
const tables = await sql`
  SELECT name, type FROM sqlite_master
  WHERE type IN ('table', 'view') ORDER BY name
`;
const columns = await sql`PRAGMA table_info(${table})`;
```

### 3.3 — Sidecar endpoints

```
GET  /schema/:connId/databases
GET  /schema/:connId/schemas?db=
GET  /schema/:connId/tables?schema=
GET  /schema/:connId/columns?schema=&table=
GET  /schema/:connId/indexes?schema=&table=
GET  /schema/:connId/fks?schema=&table=
```

### 3.4 — Frontend: tree panel

- Collapsible tree: Connection → Database → Schema → Tables/Views
- Lazy load each level on expand (don't fetch all at once)
- Right-click context menu: "Copy name", "View DDL", "Truncate", "Drop"
- Column sub-items show type badge (VARCHAR, INT, etc.)
- Foreign key columns show a link icon, clickable to navigate to the referenced table

### Deliverables
- [ ] Full tree renders for Postgres, MySQL, SQLite
- [ ] Lazy loading per level
- [ ] Columns show type, nullable, default, PK/FK badges
- [ ] Context menu with basic actions

---

## Phase 4 — Table Data Viewer

**Goal**: Click a table → see its rows in a spreadsheet grid with pagination, sort, filter, and inline editing.

### 4.1 — Sidecar: data endpoint

`POST /data/:connId/query`

```ts
// Paginated table fetch
const rows = await sql`
  SELECT *
  FROM ${sql(schema + "." + table)}
  ORDER BY ${sql(sortCol)} ${sql(sortDir)}
  LIMIT ${limit} OFFSET ${offset}
`;

const [{ count }] = await sql`
  SELECT COUNT(*) as count FROM ${sql(schema + "." + table)}
`;
```

Return:
```json
{
  "rows": [...],
  "columns": [{ "name": "id", "type": "int4", "nullable": false }],
  "total": 10432,
  "page": 1,
  "pageSize": 100
}
```

### 4.2 — Inline editing

Track a `pendingChanges: Map<rowId, Partial<row>>` in component state. Changes are staged (yellow cell highlight) until the user hits **Apply** or **Discard**.

On apply:
```ts
// sidecar generates UPDATE per changed row
await sql`
  UPDATE ${sql(table)}
  SET ${sql(changes)}
  WHERE ${sql(pkCol)} = ${pkVal}
`;
```

### 4.3 — Frontend: AG Grid setup

```tsx
import { AgGridReact } from "ag-grid-react";

<AgGridReact
  rowData={rows}
  columnDefs={columnDefs}
  pagination={true}
  paginationPageSize={100}
  onCellValueChanged={handleCellEdit}
  getRowId={(p) => String(p.data[pkColumn])}
  // enable clipboard paste
  enableCellTextSelection={true}
  copyHeadersToClipboard={true}
/>
```

Custom cell renderers:
- `NULL` shown as grayed-out badge, not empty string
- JSON values shown as `{…}` with click to expand in modal
- Long text truncated with hover tooltip
- Foreign key values shown with → icon, click navigates to referenced row

### 4.4 — Toolbar

```
[ Filter... ] [ Sort ↕ ] [ + Add Row ] [ ⟳ Refresh ] [ ↓ Export ] [ Apply ] [ Discard ]
```

Filter builds a `WHERE` clause from a structured filter builder (column → operator → value), not free-text SQL (that's the editor's job).

### Deliverables
- [ ] Table rows load with pagination
- [ ] Sort by column header click
- [ ] Filter builder
- [ ] Inline cell editing with staged changes
- [ ] Add row / delete row
- [ ] Export to CSV and JSON
- [ ] NULL rendering
- [ ] JSON cell expand modal

---

## Phase 5 — SQL Editor

**Goal**: A full Monaco-based SQL editor with schema-aware autocomplete, execution, and result display.

### 5.1 — Monaco setup

```ts
import * as monaco from "monaco-editor";

monaco.languages.register({ id: "sql" });
monaco.editor.create(containerEl, {
  language: "sql",
  theme: "vs-dark",
  fontSize: 13,
  fontFamily: "Berkeley Mono, JetBrains Mono, monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "on",
});
```

### 5.2 — Schema-aware autocomplete

On connection open, fetch all tables + columns and register a completion provider:

```ts
monaco.languages.registerCompletionItemProvider("sql", {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const suggestions = [
      ...tables.map((t) => ({
        label: t.name,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: t.name,
      })),
      ...columns.map((c) => ({
        label: c.name,
        detail: c.type,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: c.name,
      })),
    ];
    return { suggestions };
  },
});
```

Re-register on schema refresh.

### 5.3 — Multi-statement execution

Split on `;`, let user run all or just the statement under cursor (`Cmd+Enter` = run current, `Cmd+Shift+Enter` = run all).

```ts
// sidecar/routes/query.ts
export async function runQuery(connId: string, sql_text: string) {
  const client = getClient(connId);
  const start = performance.now();
  try {
    const rows = await client.unsafe(sql_text);
    return {
      rows,
      rowCount: rows.length,
      duration: performance.now() - start,
      error: null,
    };
  } catch (e) {
    return { rows: [], rowCount: 0, duration: 0, error: e.message };
  }
}
```

Use `sql.unsafe()` for the editor — it bypasses prepared statement restrictions and allows multi-statement, DDL, etc.

### 5.4 — Result tabs

Below the editor, show result panels — one per statement executed. Each has:
- Row count + execution time
- AG Grid result table (same component as Phase 4, read-only)
- Error display with line highlighting back in the editor

### 5.5 — Query history

Every execution is appended to a history store (last 500 queries, per connection). Accessible via `Cmd+H` — shows timestamp, duration, first 80 chars of query.

### 5.6 — Saved queries

`Cmd+S` saves a query with a name. Stored via `tauri-plugin-store`. Shown in a sidebar panel.

### Deliverables
- [ ] Monaco editor with SQL highlighting
- [ ] Schema-aware autocomplete (tables + columns)
- [ ] `Cmd+Enter` to run statement at cursor
- [ ] Multi-result tabs
- [ ] Execution time + row count display
- [ ] Error highlighting in editor
- [ ] Query history (`Cmd+H`)
- [ ] Save/load named queries

---

## Phase 6 — Schema Editor (DDL GUI)

**Goal**: Create/alter tables, add columns, manage indexes and foreign keys without writing SQL.

### 6.1 — Table structure editor

A form-based UI for the column list of a table:

| Column | Type | Length | Default | Nullable | PK | FK |
|---|---|---|---|---|---|---|
| id | INTEGER | — | — | ✗ | ✓ | — |
| user_id | INTEGER | — | — | ✗ | ✗ | → users.id |

Add/remove/reorder rows. On save, the sidecar generates the correct `ALTER TABLE` statements for the delta.

### 6.2 — DDL generation per dialect

This is the most dialect-sensitive part. Each DB has different `ALTER TABLE` support:

- **PostgreSQL**: Full `ALTER TABLE ... ADD COLUMN`, `ALTER COLUMN`, `DROP COLUMN`
- **MySQL**: Similar but `MODIFY COLUMN` instead of `ALTER COLUMN`
- **SQLite**: No `ALTER COLUMN` or `DROP COLUMN` pre-3.35 — must recreate table

For SQLite, the sidecar implements the [12-step table recreation procedure](https://www.sqlite.org/lang_altertable.html):
1. `CREATE TABLE new_table (...)`
2. `INSERT INTO new_table SELECT ... FROM old_table`
3. `DROP TABLE old_table`
4. `ALTER TABLE new_table RENAME TO old_table`

Wrap in a transaction.

### 6.3 — Index manager

Separate tab in the structure view. Shows existing indexes, lets you add/drop. Generates `CREATE INDEX` / `DROP INDEX`.

### 6.4 — View DDL

Right-click any table → "View DDL" — shows the `CREATE TABLE` statement as returned by:
- Postgres: `pg_get_tabledef()`
- MySQL: `SHOW CREATE TABLE`
- SQLite: `sqlite_master.sql`

Syntax highlighted, copyable.

### Deliverables
- [x] Column editor (add, edit type, set nullable/default/PK)
- [x] Generates correct ALTER TABLE SQL per dialect
- [x] SQLite table-recreation workaround
- [x] Index manager
- [x] FK editor
- [x] View DDL modal

---

## Phase 7 — UI Polish & TablePlus Parity

**Goal**: The details that make the difference between "usable" and "polished."

### 7.1 — Tab system

- Each open table or editor is a tab
- Tabs have connection color accent (set in Phase 2)
- Drag to reorder
- `Cmd+T` new editor tab, `Cmd+W` close tab
- Tab persists its scroll position and filter state

### 7.2 — Multi-connection

- Multiple connections open simultaneously, each in their own tab group
- Left sidebar shows all open connections
- Color coding per connection so you never lose track of which env you're in (huge TablePlus feature)

### 7.3 — Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Enter` | Run query at cursor |
| `Cmd+Shift+Enter` | Run all queries |
| `Cmd+R` | Refresh table data |
| `Cmd+F` | Focus filter bar |
| `Cmd+H` | Query history |
| `Cmd+S` | Save query |
| `Cmd+K` | Command palette |
| `Cmd+T` | New editor tab |
| `Cmd+W` | Close tab |
| `Cmd+1..9` | Switch tabs |
| `Escape` | Discard pending changes |

### 7.4 — Command palette (`Cmd+K`)

Fuzzy search across:
- Open connections
- Tables (in any open connection)
- Saved queries
- Actions ("New connection", "Export table", etc.)

Use `fuse.js` for the fuzzy matching.

### 7.5 — Dark/light theme

Respect system preference via `prefers-color-scheme`. Monaco has its own theme API — sync it.

### 7.6 — Window state persistence

Use `tauri-plugin-window-state` to remember window size, position, and which tabs were open.

### 7.7 — EXPLAIN visualizer

For `SELECT` queries, add a button "Explain" that runs `EXPLAIN ANALYZE` and renders the plan as a node tree diagram using a simple canvas/SVG renderer. Not a full feature — just the cost breakdown tree.

### Deliverables
- [ ] Drag-reorderable tabs
- [ ] Multi-connection with color coding
- [ ] Full keyboard shortcut set
- [ ] Command palette with fuzzy search
- [ ] Dark/light theme sync with Monaco
- [ ] Window state persistence
- [ ] Basic EXPLAIN visualizer

---

## Phase 8 — Packaging & Distribution

**Goal**: A signed, notarized, auto-updating app for macOS, Windows, and Linux.

### 8.1 — Sidecar cross-compilation

Build the Bun sidecar for all targets from CI:

```bash
# macOS arm64
bun build --compile --target=bun-darwin-arm64 sidecar/index.ts \
  --outfile src-tauri/binaries/dbsidecar-aarch64-apple-darwin

# macOS x64
bun build --compile --target=bun-darwin-x64 sidecar/index.ts \
  --outfile src-tauri/binaries/dbsidecar-x86_64-apple-darwin

# Windows x64
bun build --compile --target=bun-windows-x64 sidecar/index.ts \
  --outfile src-tauri/binaries/dbsidecar-x86_64-pc-windows-msvc.exe

# Linux x64
bun build --compile --target=bun-linux-x64 sidecar/index.ts \
  --outfile src-tauri/binaries/dbsidecar-x86_64-unknown-linux-gnu
```

### 8.2 — Code signing

- **macOS**: Requires Apple Developer ID cert. Tauri handles notarization via `APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD` env vars in CI. The sidecar binary must also be signed separately before being bundled.
- **Windows**: Requires EV code signing cert. Set `certificateThumbprint` in `tauri.conf.json`.
- **Linux**: AppImage and `.deb` don't require signing but GPG sign the release artifacts.

### 8.3 — Auto-update

Tauri has a built-in updater. Host update manifests on GitHub Releases:

```json
// tauri.conf.json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/yourorg/yourapp/releases/latest/download/latest.json"
      ],
      "dialog": true
    }
  }
}
```

On startup, check for updates. Show a non-blocking banner if one is available.

### 8.4 — CI pipeline (GitHub Actions)

```yaml
jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Build sidecar
        run: bun build --compile ...
      - uses: tauri-apps/tauri-action@v0
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          # etc.
```

### 8.5 — Approximate final bundle sizes

| Platform | Estimated size |
|---|---|
| macOS (arm64) `.dmg` | ~75–85 MB |
| Windows `.msi` | ~70–80 MB |
| Linux `.AppImage` | ~80–90 MB |

### Deliverables
- [ ] Sidecar compiled for all 4 targets
- [ ] Signed + notarized macOS build
- [ ] Signed Windows installer
- [ ] Linux AppImage + .deb
- [ ] Auto-updater with GitHub Releases
- [ ] GitHub Actions CI/CD pipeline

---

## Phase Summary

| Phase | Focus | Effort |
|---|---|---|
| 1 | Scaffold + sidecar wiring | 2–3 days |
| 2 | Connection manager | 3–4 days |
| 3 | Schema browser | 4–5 days |
| 4 | Table data viewer | 5–7 days |
| 5 | SQL editor | 4–5 days |
| 6 | Schema editor (DDL GUI) | 6–8 days |
| 7 | UI polish + parity | 5–7 days |
| 8 | Packaging + CI | 2–3 days |
| **Total** | | **~6–8 weeks solo** |

---

## Key Risk Areas

**Dialect divergence in Phase 6** is the highest-risk work. SQLite's limited `ALTER TABLE` support means you're essentially writing a migration engine for it. Budget extra time here.

**Monaco autocomplete freshness** — schema changes made in the editor won't be reflected in autocomplete until you trigger a re-fetch. Build a manual "Refresh schema" action and call it automatically after DDL execution.

**Sidecar port binding on startup** — if the app crashes without cleanup, the port stays occupied. Use a fixed port + a kill-on-bind strategy rather than a random port.

**macOS notarization of the Bun sidecar binary** — Apple requires every executable in the bundle to be individually signed and notarized. This includes your compiled Bun binary. Set this up early — discovering it late is painful.
