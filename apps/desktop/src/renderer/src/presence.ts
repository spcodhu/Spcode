import { useEffect, useRef, useState } from "react";

/**
 * 为条件渲染补退出动画：关闭时保留 DOM 到过渡结束，打开时在下一帧切到可见态。
 * animating 仅用于需要在动画结束后关闭 transition 的场景（例如拖拽调宽不能被过渡拖慢）。
 */
export function usePresence(open: boolean, duration: number) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState(open);
  const mountedRef = useRef(open);
  mountedRef.current = mounted;

  useEffect(() => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const ms = reducedMotion ? 0 : duration;
    let frame: number | undefined;
    let timer: number | undefined;

    if (open) {
      setMounted(true);
      setAnimating(true);
      // 先以隐藏态挂载，再在下一帧切换目标值，确保浏览器有机会产生进入过渡。
      frame = requestAnimationFrame(() => {
        setVisible(true);
        timer = window.setTimeout(() => setAnimating(false), ms);
      });
    } else {
      setVisible(false);
      if (mountedRef.current) {
        setAnimating(true);
        timer = window.setTimeout(() => {
          setMounted(false);
          setAnimating(false);
        }, ms);
      } else {
        setAnimating(false);
      }
    }

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, duration]);

  return { mounted, visible: open && visible, animating };
}
