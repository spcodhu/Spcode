/**
 * 渲染崩溃兜底（评审 P2-6）：一个组件抛错不再白屏整个应用。
 * React 只有 class 组件能接 componentDidCatch，这是全仓唯一的 class 组件。
 */
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 出错时显示的区块名（如「会话区」），也用于 console 日志定位 */
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
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-[14px] font-medium text-danger">{this.props.label ?? "界面"}渲染出错</div>
        <div className="max-w-md break-all text-[12px] leading-5 text-text-tertiary">{error.message}</div>
        <button
          onClick={() => this.setState({ error: null })}
          className="rounded-lg border border-border bg-bg-elevated px-4 py-2 text-[13px] text-text-primary hover:bg-bg-hover"
        >
          重试
        </button>
      </div>
    );
  }
}
