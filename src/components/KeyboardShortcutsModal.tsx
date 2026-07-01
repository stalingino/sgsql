import { useEffect } from "react";
import { X } from "lucide-react";
import { isMac, modKey, ctrlKey } from "../lib/platform";

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const GROUPS = [
  {
    label: "General",
    shortcuts: [
      { action: "Command palette", keys: modKey("P") },
      { action: "Settings", keys: modKey(",") },
      { action: "Keyboard shortcuts", keys: modKey("/") },
      { action: "Save all changes", keys: modKey("S") },
      { action: "Undo pending edit", keys: modKey("Z") },
      { action: "Close tab", keys: modKey("W") },
    ],
  },
  {
    label: "Navigation",
    shortcuts: [
      { action: "New connection", keys: modKey("N") },
      { action: "New SQL query tab", keys: modKey("E") },
      { action: "Switch database", keys: modKey("K") },
    ],
  },
  {
    label: "View",
    shortcuts: [
      { action: "Toggle sidebar", keys: modKey("L") },
      { action: "Toggle detail panel", keys: modKey("O") },
      { action: "Toggle bottom panel", keys: modKey(".") },
      { action: "Reload connection", keys: modKey("R") },
    ],
  },
  {
    label: "Query editor",
    shortcuts: [
      { action: "Run query", keys: ctrlKey("↩", "Enter") },
      { action: "Open autocomplete", keys: ctrlKey("Space") },
    ],
  },
  {
    label: "Data table",
    shortcuts: [
      { action: "Add row", keys: modKey("I") },
      { action: "Toggle filters", keys: modKey("F") },
      { action: "Copy selected rows", keys: modKey("C") },
      { action: "Select all rows", keys: modKey("A") },
      { action: "Delete selected rows", keys: isMac ? "⌫" : "Delete" },
      { action: "Extend selection", keys: isMac ? "⇧↑↓" : "Shift+↑↓" },
    ],
  },
];

export function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[480px] max-h-[80vh] bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden no-select flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-secondary shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover transition-colors cursor-pointer text-text-muted hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.shortcuts.map((s) => (
                  <div key={s.action} className="flex items-center justify-between py-1">
                    <span className="text-[13px] text-text-primary">{s.action}</span>
                    <kbd className="px-2 py-0.5 text-[12px] font-mono bg-bg-secondary border border-border rounded text-text-secondary shrink-0">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
