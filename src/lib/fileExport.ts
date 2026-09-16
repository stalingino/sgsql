import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { exportExtension, serializeExport, type ExportDialect, type ExportFormat } from "./dataExport";

const LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  json: "JSON",
  ndjson: "NDJSON",
  sql: "SQL",
};

export async function chooseExportPath(suggestedName: string, format: ExportFormat): Promise<string | null> {
  return save({
    defaultPath: `${suggestedName}.${exportExtension(format)}`,
    filters: [{ name: LABELS[format], extensions: [exportExtension(format)] }],
  });
}

export async function writeExportFile(path: string, content: string, append: boolean): Promise<void> {
  await invoke("export_write", { path, content, append });
}

export interface ExportRowsOptions {
  suggestedName: string;
  format: ExportFormat;
  columns: string[];
  rows: unknown[][];
  dialect: ExportDialect;
  table: string;
  schema?: string;
  database?: string;
}

export async function exportRows(options: ExportRowsOptions): Promise<string | null> {
  const path = await chooseExportPath(options.suggestedName, options.format);
  if (!path) return null;
  await writeExportFile(path, serializeExport(options), false);
  return path;
}
