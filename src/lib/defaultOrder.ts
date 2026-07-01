export const DEFAULT_ORDER_BY = "id DESC";

export interface DefaultTableSort {
  column: string;
  dir: "ASC" | "DESC";
}

/**
 * Resolve the table sort shown in Settings.
 *
 * An absent setting uses the application default. An explicitly empty setting
 * disables default ordering.
 */
export function parseDefaultOrderBy(configured: string | undefined): DefaultTableSort | null {
  const orderBy = (configured ?? DEFAULT_ORDER_BY).trim();
  if (!orderBy) return null;

  const [column, direction = "DESC"] = orderBy.split(/\s+/);
  return {
    column,
    dir: direction.toUpperCase() === "ASC" ? "ASC" : "DESC",
  };
}
