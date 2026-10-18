import { Component, type ReactNode } from "react";

export function ViewLoading({ entry = false }: { entry?: boolean }) {
  return (
    <div className={entry ? "loading-screen" : "view-loading"} role="status">
      Loading view…
    </div>
  );
}

export class ViewBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="error-banner" role="alert">
          <span>This view could not be opened. Please reload to try again.</span>
          <button className="btn btn-outline btn-sm" onClick={() => location.reload()}>
            Reload view
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
