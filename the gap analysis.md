# sgsql gap analysis

Updated: 2026-06-21

Scope: implementation compared with `sgsql-plan.md`. Status is based on source inspection, a successful production build, generator tests, and SQLite schema-apply integration tests. Live PostgreSQL and MySQL integration coverage is still absent.

## Summary

Phases 1, 2, and 6 are substantially complete. Phase 4 has also progressed significantly and now contains the core staged CRUD workflow. The largest product gaps are table context actions in Phase 3, file export and JSON expansion in Phase 4, and most of the planned editor workflow in Phase 5.

| Phase | Status | Main remaining gap |
|---|---|---|
| 1 — Scaffold and sidecar | ✅ Substantially complete | Cross-platform sidecar packaging belongs to Phase 8 |
| 2 — Connection manager | ✅ Substantially complete | Runtime coverage across all database types is not automated |
| 3 — Schema browser | 🟡 Partial | Table context actions remain limited |
| 4 — Table data viewer | 🟢 Mostly complete | No downloadable export or JSON expand modal |
| 5 — SQL editor | 🟡 Partial | No Monaco, multi-result tabs, error markers, or saved queries |
| 6 — Schema editor | ✅ Substantially complete | Live PostgreSQL/MySQL integration coverage remains |
| 7 — UI polish | 🟡 Partial | Tab reordering, full shortcuts, and EXPLAIN are absent |
| 8 — Distribution | 🔴 Early | Apple Silicon local build only; no release pipeline |

## Phase 1 — Scaffold and sidecar

Status: ✅ Substantially complete

- Tauri launches the Bun sidecar and waits for its health endpoint.
- Production ports are selected from `7521`–`7530`; direct development uses `45821`.
- The selected port is exposed to the frontend and covered by the CSP.
- Sidecar and database connections are cleaned up on application shutdown.

Remaining concern:

- The configured sidecar artifact is Apple Silicon-specific. Other macOS architectures, Windows, and Linux are Phase 8 work.

## Phase 2 — Connection manager

Status: ✅ Substantially complete

- Add, edit, delete, filter, and test connection profiles are implemented.
- PostgreSQL, MySQL, and SQLite profiles are supported.
- Profiles persist in the encrypted Tauri store.
- Passwords are kept in the OS keychain rather than in the profile store.
- Connection URL parsing and environment/color labels are implemented.
- Connection errors are converted to user-facing messages.

Remaining concern:

- There is no automated integration suite proving save/load/test behavior for every database type.

## Phase 3 — Schema browser

Status: 🟡 Partial

Implemented:

- Database tabs and a searchable table/view list.
- Table metadata loading for PostgreSQL, MySQL, and SQLite.
- Column metadata with type, nullable, default, primary-key, and foreign-key indicators in the table Structure view.
- Lazy loading and caching of tables per selected database; columns load when a table opens.

Gaps:

- The planned hierarchy `database → schema → table/view → column` is not present.
- PostgreSQL is fixed to the `public` schema in the UI, so tables in other schemas cannot be browsed.
- Columns are not expandable children in the schema browser.
- Table/view right-click actions are absent: Copy name, View DDL, Truncate, and Drop.
- Foreign-key columns do not navigate to the referenced table.
- The only current schema-area context menu removes a database tab.

## Phase 4 — Table data viewer

Status: 🟢 Mostly complete

Implemented:

- Server-side pagination at 100 rows per page.
- Header-click sorting with ascending, descending, and cleared states.
- Structured filter builder, raw SQL mode, generated-SQL preview, apply, and clear.
- Staged cell updates through the detail panel with type-aware inputs and dirty-state highlighting.
- Staged row insertion and primary-key-based deletion.
- Apply, discard, undo, and change-history workflows for pending updates, inserts, and deletes.
- NULL rendering, row selection, column resizing, and client-side copy actions.
- Copy selected rows as JSON, CSV, CSV with headers, HTML, Markdown, plain text, or INSERT SQL.

Gaps:

- CSV/JSON support copies data to the clipboard; it does not export a downloadable file or a complete table result.
- JSON values render inline and can be viewed as formatted text in the detail panel, but there is no dedicated expand modal.
- Editing occurs in the detail panel rather than directly inside grid cells. The staged editing outcome exists, but it does not match the plan's literal inline-grid interaction.
- Foreign-key values are not clickable navigation links.
- The implementation uses a custom grid rather than AG Grid. This is only a gap if AG Grid remains a product requirement.

## Phase 5 — SQL editor

Status: 🟡 Partial

Implemented:

- Custom textarea editor with a syntax-highlight overlay.
- Selection execution and statement-at-cursor execution with `Cmd/Ctrl+Enter`.
- Schema-aware table/view autocomplete across PostgreSQL schemas, plus lazy column autocomplete for relations referenced by the active statement. Alias-qualified completion and `Ctrl+Space` are supported.
- Beautify action and row-limit selection.
- Execution time, affected-row count, result row count, pagination, cancellation, and error display.
- Query results can participate in staged editing when a safe single-table context and primary key can be inferred.
- An in-memory query console exists for the current session.

Gaps:

- Monaco is not installed or used.
- No separate results per statement and no multi-result tabs.
- No editor line/column error markers.
- Query history is not the planned persistent, per-connection last-500 history and has no `Cmd+H` workflow. Logging is enabled only while the console is visible.
- No save/load named-query workflow. `Cmd/Ctrl+S` currently applies pending data changes.
- No `Cmd/Ctrl+Shift+Enter` run-all workflow.

## Phases 6–8

### Phase 6 — Schema editor

Status: ✅ Substantially complete

Implemented: create-table flow, editable columns with dialect-aware DDL, atomic PostgreSQL/SQLite schema batches, guarded MySQL partial-commit reporting, SQLite table recreation with preservation of raw indexes/triggers/table options, editable indexes, composite foreign keys with actions, schema-aware cache invalidation, PostgreSQL schema selection, and copyable DDL/review modals.

PostgreSQL physical column reordering is intentionally disabled because PostgreSQL has no safe generic operation for it. Live PostgreSQL/MySQL integration tests remain the principal validation gap.

### Phase 7 — UI polish

Status: 🟡 Partial

Implemented: multiple connections with color/environment cues, connection/database/content tabs, command palette, light/dark/system themes, resizable panels, window-state persistence, query cancellation, and several keyboard shortcuts.

Remaining: drag-reorderable tabs, the complete planned shortcut set, persisted tab/workspace state, saved-query integration in the command palette, and an EXPLAIN visualizer.

### Phase 8 — Packaging and distribution

Status: 🔴 Early

Local Apple Silicon sidecar compilation and Tauri bundling are documented. Intel/universal macOS, Windows, Linux, signing/notarization, auto-update, and CI/CD release automation remain.

## Recommended next work

### 1. Add real schema selection to the browser

This is the highest-leverage next fix. Add a schema level for PostgreSQL, carry the selected schema through table tabs and queries, and stop assuming `public`. This fixes access to non-public schemas and supplies the metadata model needed for autocomplete and future DDL tooling.

Suggested acceptance criteria:

- PostgreSQL schemas are listed per database and can be expanded or selected.
- Tables and views load for the selected schema.
- Opening two same-named tables from different schemas creates distinct tabs and queries the correct object.
- MySQL and SQLite retain their simpler database/table behavior.

### 2. Add table context actions

Start with Copy qualified name and View DDL. They are bounded, high-frequency actions and naturally build on the schema identity work. Put Truncate and Drop behind explicit confirmation and environment-aware warnings.

### 3. Add file export

Reuse the existing CSV/JSON serializers, add a save-file flow, and distinguish selected rows/current page/all rows. “All rows” should stream or page through results instead of loading an unbounded table into memory.

### 4. Add multi-result execution

Split run-all execution into individual statements and retain one result or error panel per statement. This is higher value than migrating the working custom editor to Monaco solely to match the original stack choice.

### 5. Make query history durable

Log regardless of console visibility, cap entries, scope them per connection, persist them, and add the planned `Cmd/Ctrl+H` browser. Resolve the `Cmd/Ctrl+S` conflict before implementing saved queries.

## Engineering gaps

- `bun run build` succeeds.
- A focused unit test covers schema-qualified table suggestions and alias-qualified column suggestions; broader database integration coverage is still absent.
- The next feature should include focused tests for identifier quoting and schema-qualified object selection, because those paths vary by database dialect and are easy to regress.
