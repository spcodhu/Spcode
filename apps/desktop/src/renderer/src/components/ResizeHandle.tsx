import { useCallback, useEffect, useRef } from "react";

interface ResizeHandleProps {
  label: string;
  testId: string;
  value: number;
  min: number;
  max: number;
  /** 左栏手柄向右拖增大为 1；右栏手柄向右拖减小为 -1 */
  direction: 1 | -1;
  onChange: (value: number) => void;
  onReset: () => void;
}

/** 可访问的竖向窗口分隔手柄：Pointer 拖拽 + 键盘微调 + 双击复位。 */
export function ResizeHandle({ label, testId, value, min, max, direction, onChange, onReset }: ResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  const bodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);

  const stopDrag = useCallback(() => {
    dragRef.current = null;
    if (bodyStyleRef.current) {
      document.body.style.cursor = bodyStyleRef.current.cursor;
      document.body.style.userSelect = bodyStyleRef.current.userSelect;
      bodyStyleRef.current = null;
    }
  }, []);
  useEffect(() => stopDrag, [stopDrag]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: 可拖拽 window splitter 需要 Pointer Capture、完整高度与键盘交互，div 是合适实现
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      data-testid={testId}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
        bodyStyleRef.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onChange(drag.startValue + (event.clientX - drag.startX) * direction);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        stopDrag();
      }}
      onPointerCancel={stopDrag}
      onLostPointerCapture={stopDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onChange(value + (event.key === "ArrowRight" ? 16 : -16) * direction);
        } else if (event.key === "Home") {
          event.preventDefault();
          onChange(min);
        } else if (event.key === "End") {
          event.preventDefault();
          onChange(max);
        }
      }}
      className="relative z-20 flex w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center border-0 outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border after:transition-colors hover:after:bg-border-strong focus-visible:outline-2 focus-visible:outline-accent"
    />
  );
}
