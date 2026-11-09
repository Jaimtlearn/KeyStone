import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import { App } from "./App";

// No <StrictMode>: its double-invoked effects would open every SSH session twice in dev.
/** Render-time crashes show a readable error instead of a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ position: "fixed", inset: 0, padding: 40, overflow: "auto", background: "#0f1117", color: "#e6e9f2", font: "14px/1.5 system-ui, sans-serif" }}>
        <h2 style={{ margin: "0 0 12px", fontWeight: 600 }}>Keystone hit an error</h2>
        <pre style={{ whiteSpace: "pre-wrap", background: "#171a23", border: "1px solid #2a2f3d", borderRadius: 8, padding: 16, font: "12px/1.5 ui-monospace, monospace", userSelect: "text" }}>
          {String(error.stack || error)}
        </pre>
        <button onClick={() => location.reload()} style={{ marginTop: 16, padding: "8px 14px", borderRadius: 6, border: "1px solid #2a2f3d", background: "#1d2130", color: "inherit", cursor: "pointer" }}>
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

// Block the webview's default context menu outside text inputs; we provide our own.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .selectable, .xterm")) e.preventDefault();
});
