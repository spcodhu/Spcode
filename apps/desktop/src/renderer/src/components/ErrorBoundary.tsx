/** Rendering failures keep the original error visible and remain locale-reactive. */
import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error(`[ErrorBoundary:${this.props.label ?? "app"}]`, error.message, info.componentStack ?? "");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} label={this.props.label} onRetry={() => this.setState({ error: null })} />;
  }
}

function ErrorFallback({ error, label, onRetry }: { error: Error; label?: string; onRetry: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-[14px] font-medium text-danger">
        {t("error.render", { label: label ?? t("error.interface") })}
      </div>
      <div className="max-w-md break-all text-[12px] leading-5 text-text-tertiary">{error.message}</div>
      <button
        type="button"
        data-testid="render-error-retry"
        onClick={onRetry}
        className="rounded-lg border border-border bg-bg-elevated px-4 py-2 text-[13px] text-text-primary hover:bg-bg-hover"
      >
        {t("common.retry")}
      </button>
    </div>
  );
}
