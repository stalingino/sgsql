import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Database,
  Layers,
  Table2,
  Eye,
  Columns2,
  KeyRound,
  Link2,
  Loader2,
} from "lucide-react";
import {
  fetchDatabases,
  fetchSchemas,
  fetchTables,
  fetchColumns,
  type TableInfo,
  type ColumnInfo,
} from "../lib/schema";

interface SchemaTreeProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  connectionDatabase: string;
  onTableSelect?: (db: string, schema: string, table: string) => void;
}

type NodeKind = "database" | "schema" | "table-group" | "table" | "view" | "column";

interface TreeNode {
  kind: NodeKind;
  label: string;
  db: string;
  schema: string;
  table: string;
  columnInfo?: ColumnInfo;
  tableType?: "table" | "view";
}

export function SchemaTree({
  connectionId,
  connectionType,
  connectionDatabase,
  onTableSelect,
}: SchemaTreeProps) {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const nodes = await loadRootNodes(connectionId, connectionType, connectionDatabase);
        if (!cancelled) setRootNodes(nodes);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [connectionId, connectionType, connectionDatabase]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        Loading schema...
      </div>
    );
  }

  if (error) {
    return <div className="px-3 py-4 text-xs text-error">{error}</div>;
  }

  if (rootNodes.length === 0) {
    return <div className="px-3 py-4 text-xs text-text-muted">No objects found.</div>;
  }

  return (
    <div className="py-1 text-sm select-none overflow-y-auto h-full">
      {rootNodes.map((node) => (
        <LazyNode
          key={nodeKey(node)}
          node={node}
          depth={0}
          connectionId={connectionId}
          connectionType={connectionType}
          connectionDatabase={connectionDatabase}
          onTableSelect={onTableSelect}
        />
      ))}
    </div>
  );
}

interface LazyNodeProps {
  node: TreeNode;
  depth: number;
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  connectionDatabase: string;
  onTableSelect?: (db: string, schema: string, table: string) => void;
}

function LazyNode({ node, depth, connectionId, connectionType, connectionDatabase, onTableSelect }: LazyNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);

  const isLeaf = node.kind === "column";

  const toggle = useCallback(async () => {
    if (isLeaf) return;

    if (expanded) { setExpanded(false); return; }

    setExpanded(true);
    if (children !== null) return;

    setLoading(true);
    try {
      const loaded = await loadChildren(connectionId, connectionType, connectionDatabase, node);
      setChildren(loaded);
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [expanded, children, isLeaf, connectionId, connectionType, connectionDatabase, node]);

  const handleClick = () => {
    if (isLeaf) return;
    if (node.kind === "table" || node.kind === "view") {
      onTableSelect?.(node.db, node.schema, node.label);
    }
    toggle();
  };

  return (
    <>
      <div
        className={`flex items-center gap-1.5 py-[3px] pr-2 transition-colors group
          ${isLeaf ? "cursor-default" : "cursor-pointer hover:bg-bg-hover"}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={handleClick}
      >
        {/* Disclosure chevron */}
        <span className="w-4 shrink-0 flex items-center justify-center text-text-muted">
          {!isLeaf && (
            expanded
              ? <ChevronDown size={11} />
              : <ChevronRight size={11} />
          )}
        </span>

        {/* Icon */}
        <NodeIcon node={node} />

        {/* Label */}
        <span className={`truncate text-[13px] ${
          node.kind === "column" ? "text-text-secondary" : "text-text-primary"
        }`}>
          {node.label}
        </span>

        {/* Column: type + badges */}
        {node.kind === "column" && node.columnInfo && (
          <ColumnBadges column={node.columnInfo} />
        )}
      </div>

      {/* Loading children */}
      {expanded && loading && (
        <div
          className="flex items-center gap-1.5 py-[3px] text-xs text-text-muted"
          style={{ paddingLeft: `${(depth + 1) * 14 + 6 + 20}px` }}
        >
          <Loader2 size={10} className="animate-spin" />
          Loading...
        </div>
      )}

      {expanded && children?.map((child) => (
        <LazyNode
          key={nodeKey(child)}
          node={child}
          depth={depth + 1}
          connectionId={connectionId}
          connectionType={connectionType}
          connectionDatabase={connectionDatabase}
          onTableSelect={onTableSelect}
        />
      ))}
    </>
  );
}

function NodeIcon({ node }: { node: TreeNode }) {
  const cls = "shrink-0";
  switch (node.kind) {
    case "database":
      return <Database size={14} className={`${cls} text-text-muted`} />;
    case "schema":
      return <Layers size={14} className={`${cls} text-text-muted`} />;
    case "table":
      return <Table2 size={14} className={`${cls} text-accent`} />;
    case "view":
      return <Eye size={14} className={`${cls} text-purple-400`} />;
    case "column":
      return <Columns2 size={13} className={`${cls} text-text-muted`} />;
    default:
      return null;
  }
}

function ColumnBadges({ column }: { column: ColumnInfo }) {
  return (
    <span className="ml-auto flex items-center gap-1 shrink-0">
      <span className="text-[10px] text-text-muted font-mono leading-none">
        {column.udtName || column.dataType}
      </span>
      {column.isPk && (
        <span className="flex items-center gap-0.5 text-[9px] font-semibold text-warning px-1 rounded bg-warning/10">
          <KeyRound size={8} />PK
        </span>
      )}
      {column.isFk && (
        <span className="flex items-center gap-0.5 text-[9px] font-semibold text-accent px-1 rounded bg-accent/10">
          <Link2 size={8} />FK
        </span>
      )}
    </span>
  );
}

async function loadRootNodes(
  connectionId: string,
  connectionType: "postgres" | "mysql" | "sqlite",
  connectionDatabase: string,
): Promise<TreeNode[]> {
  switch (connectionType) {
    case "sqlite": {
      const tables = await fetchTables(connectionId, connectionDatabase, "main");
      return tablesToNodes(tables, connectionDatabase, "main");
    }
    case "mysql": {
      const dbs = await fetchDatabases(connectionId);
      return dbs.map((db) => ({ kind: "database" as const, label: db, db, schema: "", table: "" }));
    }
    case "postgres": {
      const schemas = await fetchSchemas(connectionId, connectionDatabase);
      return schemas.map((s) => ({ kind: "schema" as const, label: s, db: connectionDatabase, schema: s, table: "" }));
    }
  }
}

async function loadChildren(
  connectionId: string,
  connectionType: "postgres" | "mysql" | "sqlite",
  _connectionDatabase: string,
  parent: TreeNode,
): Promise<TreeNode[]> {
  switch (parent.kind) {
    case "database": {
      if (connectionType === "mysql") {
        const tables = await fetchTables(connectionId, parent.db, "");
        return tablesToNodes(tables, parent.db, "");
      }
      const schemas = await fetchSchemas(connectionId, parent.db);
      return schemas.map((s) => ({ kind: "schema" as const, label: s, db: parent.db, schema: s, table: "" }));
    }
    case "schema": {
      const tables = await fetchTables(connectionId, parent.db, parent.schema);
      return tablesToNodes(tables, parent.db, parent.schema);
    }
    case "table":
    case "view": {
      const columns = await fetchColumns(connectionId, parent.db, parent.schema, parent.label);
      return columns
        .sort((a, b) => a.position - b.position)
        .map((col) => ({
          kind: "column" as const,
          label: col.name,
          db: parent.db,
          schema: parent.schema,
          table: parent.label,
          columnInfo: col,
        }));
    }
    default:
      return [];
  }
}

function tablesToNodes(tables: TableInfo[], db: string, schema: string): TreeNode[] {
  return tables.map((t) => ({
    kind: (t.type === "view" ? "view" : "table") as NodeKind,
    label: t.name,
    db,
    schema,
    table: t.name,
    tableType: t.type,
  }));
}

function nodeKey(node: TreeNode): string {
  return `${node.kind}:${node.db}:${node.schema}:${node.label}`;
}
