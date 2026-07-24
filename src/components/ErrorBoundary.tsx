import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div className="h-screen flex items-center justify-center">
          <div className="text-center max-w-sm px-6">
            <div className="text-2xl mb-2">⚠</div>
            <h3 className="text-sm font-semibold text-zinc-900 mb-1">Something went wrong</h3>
            <p className="text-xs text-zinc-500 mb-3">{this.state.error.message}</p>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="text-xs text-indigo-600 hover:underline"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}