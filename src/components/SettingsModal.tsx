import { useEffect, useRef, useState } from "react";
import { X, Keyboard, RefreshCw } from "lucide-react";
import { getConfig, saveConfig, type AppSettings } from "../lib/config";
import { DEFAULT_ORDER_BY } from "../lib/defaultOrder";
import { modKey } from "../lib/platform";
import { checkForUpdate, type UpdateCheckResult } from "../lib/updater";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onShowShortcuts?: () => void;
}

export function SettingsModal({ open, onClose, onShowShortcuts }: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings>({});
  const backdropRef = useRef<HTMLDivElement>(null);
  const [updateState, setUpdateState] = useState<
    | { status: "idle" }
    | { status: "checking" }
    | { status: "installing" }
    | UpdateCheckResult
  >({ status: "idle" });

  // Load current settings when opened
  useEffect(() => {
    if (open) {
      setSettings(getConfig().settings ?? {});
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    await saveConfig({ settings });
    onClose();
  };

  const handleCheckForUpdate = async () => {
    setUpdateState({ status: "checking" });
    setUpdateState(await checkForUpdate());
  };

  const handleInstallUpdate = async () => {
    if (updateState.status !== "available") return;
    setUpdateState({ status: "installing" });
    try {
      await updateState.install();
    } catch (e) {
      setUpdateState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="w-[480px] bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden no-select">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-secondary">
          <h2 className="text-sm font-semibold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover transition-colors cursor-pointer text-text-muted hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5">
          {/* Default ORDER BY */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-text-secondary">
              Data load default ORDER BY
            </label>
            <input
              type="text"
              value={settings.defaultOrderBy ?? DEFAULT_ORDER_BY}
              onChange={(e) => updateSetting("defaultOrderBy", e.target.value)}
              placeholder="e.g. id DESC, created_at DESC, or leave empty"
              className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-bg-primary text-text-primary placeholder-text-muted outline-none focus:border-accent transition-colors font-mono"
            />
            <p className="text-[11px] text-text-muted">
              Applied when opening a table. Uses the column name if it exists, otherwise ignored. Leave empty for no default ordering.
            </p>
          </div>

          {/* Updates */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-text-secondary">
              Updates
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={updateState.status === "available" ? handleInstallUpdate : handleCheckForUpdate}
                disabled={updateState.status === "checking" || updateState.status === "installing"}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
              >
                <RefreshCw size={12} className={updateState.status === "checking" ? "animate-spin" : ""} />
                {updateState.status === "available"
                  ? "Install & restart"
                  : updateState.status === "installing"
                  ? "Installing…"
                  : "Check for updates"}
              </button>
              <span className="text-[11px] text-text-muted">
                {updateState.status === "checking" && "Checking…"}
                {updateState.status === "up-to-date" && "You're up to date."}
                {updateState.status === "available" && `Version ${updateState.version} is available.`}
                {updateState.status === "error" && `Update check failed: ${updateState.message}`}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border bg-bg-secondary">
          {onShowShortcuts && (
            <button
              onClick={onShowShortcuts}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              title={`Keyboard shortcuts (${modKey("/")})`}
            >
              <Keyboard size={12} />
              Keyboard shortcuts
            </button>
          )}
          <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-xs rounded-md bg-accent hover:bg-accent-hover text-white font-medium transition-colors cursor-pointer"
          >
            Save
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
