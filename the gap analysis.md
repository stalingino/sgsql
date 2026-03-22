the gap analysis — Phases 1-3 are essentially complete, Phases 4-5 have notable gaps:

Phase 1 — Scaffold & Sidecar ✅ Complete
All 4 deliverables done. Sidecar spawns, port 45821, dev mode detection, clean shutdown.

Phase 2 — Connection Manager ✅ Complete
All 4 deliverables done. Add/edit/delete profiles, AES-256-GCM encryption, OS keychain for passwords, test connection with feedback.

Phase 3 — Schema Browser ✅ Mostly Complete
✅ Tree renders for Postgres, MySQL, SQLite
✅ Lazy loading (databases on mount, tables on db click)
✅ Columns show type, nullable, default, PK/FK badges (in Structure view)
⚠️ Context menu on tables — only DB tabs have right-click menu (remove). Tables have no context menu for: Copy name, View DDL, Truncate, Drop
Phase 4 — Table Data Viewer 🔴 Major Gaps
✅ Pagination (100 rows/page)
✅ NULL rendering (gray italic)
❌ Sort by column header click — no sort ✅
❌ Filter builder — no WHERE clause UI
❌ Inline cell editing — cells are read-only
❌ Add row / delete row
❌ Export to CSV / JSON
❌ JSON cell expand modal — objects just stringify inline
Phase 5 — SQL Editor 🟡 Partial
✅ Custom editor with syntax highlighting (textarea + pre overlay)
✅ Ctrl+Enter runs statement at cursor
✅ Execution time + row count display
✅ Statement-at-cursor detection, selection-based execution
✅ Beautify, row limit dropdown
❌ Schema-aware autocomplete — no autocomplete at all
❌ Multi-result tabs — single result view only
❌ Error highlighting in editor — errors show below, no line markers
❌ Query history UI (Cmd+H) — log exists but no browsable history panel
❌ Save/load named queries
Priority ranking (by user impact):
#	Feature	Phase	Impact
1	Sort by column header	4	High — basic table browsing
2	Inline cell editing + Apply/Discard	4	High — core CRUD
3	Table context menu (Copy name, DDL, etc.)	3	Medium
4	Export CSV/JSON	4	Medium
5	Schema-aware autocomplete	5	High — editor usability
6	Filter builder	4	Medium
7	Add/delete row	4	Medium
8	Query history UI	5	Low-medium
9	JSON cell expand modal	4	Low
10	Multi-result tabs	5	Low
11	Error line highlighting	5	Low
12	Save/load named queries	5	Low