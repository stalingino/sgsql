import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { getConfig, saveConfig, type AppSettings } from "../lib/config";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings>({});
  const backdropRef = useRef<HTMLDivElement>(null);

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
              value={settings.defaultOrderBy ?? "id DESC"}
              onChange={(e) => updateSetting("defaultOrderBy", e.target.value)}
              placeholder="e.g. id DESC, created_at DESC, or leave empty"
              className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-bg-primary text-text-primary placeholder-text-muted outline-none focus:border-accent transition-colors font-mono"
            />
            <p className="text-[11px] text-text-muted">
              Applied when opening a table. Uses the column name if it exists, otherwise ignored. Leave empty for no default ordering.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-bg-secondary">
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
  );
}
