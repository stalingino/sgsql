import { AlertTriangle } from "lucide-react";
import { QueryConsole, QueryLogActions } from "./QueryConsole";
import { ChangeHistoryPanel, PendingChangesActions } from "./ChangeHistoryPopup";
import { useEditStore } from "../lib/editStore";

export type BottomPanelTab = "log" | "changes";

export function BottomPanel({
  tab,
  onTabChange,
}: {
  tab: BottomPanelTab;
  onTabChange: (tab: BottomPanelTab) => void;
}) {
  const changeCount = useEditStore((s) => s.changes.size + s.inserts.length + s.deletes.size);
  const saveError = useEditStore((s) => s.saveError);

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-primary">
      {/* Header: tabs on the left, the active tab's actions on the right */}
      <div className="flex items-center justify-between h-8 pr-3 border-b border-border bg-bg-secondary shrink-0">
        <div className="flex items-center h-full" role="tablist">
          <TabButton active={tab === "log"} onClick={() => onTabChange("log")}>
            Query Log
          </TabButton>
          <TabButton active={tab === "changes"} onClick={() => onTabChange("changes")}>
            Pending Changes
            {saveError ? (
              <AlertTriangle size={11} className="text-error" aria-label="Save failed" />
            ) : (
              <span className={`text-[9px] px-1.5 rounded-full font-semibold leading-4 tabular-nums ${
                changeCount > 0 ? "bg-warning/15 text-warning" : "bg-bg-hover text-text-muted"
              }`}>
                {changeCount}
              </span>
            )}
          </TabButton>
        </div>
        <div className="flex items-center">
          {tab === "log" ? <QueryLogActions /> : <PendingChangesActions />}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "log" ? <QueryConsole /> : <ChangeHistoryPanel />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex items-center gap-1.5 h-full px-3 text-[11px] font-medium cursor-pointer select-none border-r border-border shrink-0 transition-colors ${
        active
          ? "bg-bg-primary text-text-primary"
          : "bg-bg-secondary text-text-muted hover:text-text-secondary hover:bg-bg-hover"
      }`}
    >
      {children}
      {active && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />}
    </button>
  );
}
