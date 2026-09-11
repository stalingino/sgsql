import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Short label shown in the fallback, e.g. "Detail panel". */
  label?: string;
  /** Rendered instead of the crashed subtree; defaults to an inline error card. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Without a boundary, any uncaught render error unmounts the entire React tree
 * (blank window) and App's unmount cleanup closes every live connection. This
 * keeps the failure local and shows the message so it can be reported.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label ?? "ErrorBoundary"}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="flex flex-col gap-2 h-full p-3 overflow-auto text-xs text-text-primary bg-bg-primary selectable">
        <div className="font-bold text-error">{this.props.label ?? "Something"} crashed</div>
        <div className="font-mono whitespace-pre-wrap break-words">{error.message}</div>
        {error.stack && (
          <pre className="font-mono text-[10px] text-text-muted whitespace-pre-wrap break-words">{error.stack}</pre>
        )}
        <button
          onClick={this.reset}
          className="self-start px-2 py-1 rounded border border-border-light hover:bg-bg-hover cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }
}
