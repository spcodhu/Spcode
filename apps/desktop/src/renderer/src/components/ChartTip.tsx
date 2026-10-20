/**
 * 用量图表的「悬浮明细 + 点击锁定高亮」（环形图 / 堆叠柱 / 热点图共用）。
 *
 * 为什么不用原生 <title>：有约 1s 延迟、样式不可控、鼠标一停在原地就再也不刷新，
 * 也没法把「当前指向的元素」高亮出来——用起来像是图表是张死图。
 * 这里自己画提示卡片（停在指针进入元素的位置）+ 元素级高亮，点击可把高亮锁定住（再点取消）。
 *
 * 实现要点：
 * - **事件委托**：交互元素只写 `data-tip-id`（显示提示卡片）或 `data-tip-hl`
 *   （只做高亮、不弹卡片，如饼图图例行——图例行本身已有全部数字，弹卡片会盖住相邻行）。
 *   容器统一处理 mousemove/click；热点图一年有 364 个格子，逐个挂 handler
 *   会白白多出几百个闭包与 tab 停靠点。
 * - **坐标相对容器**：提示卡片是容器内的 absolute 元素，位置夹在容器内，
 *   不会飘出设置页的滚动区被裁掉；hover 只在「进入新元素」时更新状态，
 *   不在每次 mousemove 都 setState（否则拖动鼠标会重渲染整张图）。
 */
import { type ReactNode, useCallback, useRef, useState } from "react";

/** 提示卡片锚点（相对图表容器左上角的像素坐标） */
interface Tip {
  id: string;
  x: number;
  y: number;
  /** 该元素是否要弹提示卡片（false = 只参与高亮，如饼图图例行） */
  showTip: boolean;
}

/** 提示卡片宽度上限的一半 + 余量：用于把卡片夹在容器内 */
const TIP_HALF_W = 118;
/** 锚点高于这个位置就把卡片放到指针上方，否则放下方（避免顶出卡片／被滚动区裁掉） */
const FLIP_Y = 72;

export interface ChartTipApi {
  /** 绑到 position: relative 的图表容器（图表的 onMouseMove/onClick/onMouseLeave 由它提供） */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 需要高亮的元素 id：悬浮优先，其次点击锁定 */
  activeId: string | null;
  handlers: {
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseLeave: () => void;
    onClick: (e: React.MouseEvent) => void;
  };
  /** 渲染提示卡片，body 由调用方按 id 组装（无高亮元素时返回 null） */
  render: (body: (id: string) => ReactNode) => ReactNode;
}

export function useChartTip(): ChartTipApi {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Tip | null>(null);
  const [pinned, setPinned] = useState<Tip | null>(null);

  const anchorOf = useCallback((e: React.MouseEvent, hit: { id: string; showTip: boolean }): Tip => {
    const rect = containerRef.current?.getBoundingClientRect();
    const at = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
    return { id: hit.id, showTip: hit.showTip, ...at };
  }, []);

  /** 指针下的交互元素：data-tip-id 弹卡片，data-tip-hl 只高亮 */
  const hitAt = (e: React.MouseEvent): { id: string; showTip: boolean } | null => {
    const el = (e.target as Element | null)?.closest("[data-tip-id],[data-tip-hl]");
    if (!el) return null;
    const id = el.getAttribute("data-tip-id") ?? el.getAttribute("data-tip-hl");
    return id ? { id, showTip: el.hasAttribute("data-tip-id") } : null;
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const hit = hitAt(e);
    // 同一元素内移动不重渲染（否则拖鼠标会让整张图跟着重渲染）
    if ((hit?.id ?? null) === (hover?.id ?? null) && (hit?.showTip ?? false) === (hover?.showTip ?? false)) return;
    setHover(hit ? anchorOf(e, hit) : null);
  };

  const onClick = (e: React.MouseEvent) => {
    const hit = hitAt(e);
    // 点空白处（非交互元素）清掉锁定
    if (!hit) {
      setPinned(null);
      return;
    }
    setPinned((cur) => (cur?.id === hit.id ? null : anchorOf(e, hit)));
  };

  const active = hover ?? pinned;

  const render = (body: (id: string) => ReactNode) => {
    if (!active?.showTip) return null;
    // 锁定的目标可能随筛选/区间切换从图上消失（如切到 30 天后锁定的那天已不在窗口内）：
    // body 返回空就整张卡片不渲染，不留下一个只有「再点取消」的空壳
    const content = body(active.id);
    if (content == null) return null;
    const width = containerRef.current?.clientWidth ?? 0;
    const x = Math.min(Math.max(active.x, TIP_HALF_W), Math.max(TIP_HALF_W, width - TIP_HALF_W));
    const above = active.y > FLIP_Y;
    return (
      <div
        className="pointer-events-none absolute z-30 w-max max-w-[232px] rounded-lg border border-border-strong bg-bg-elevated px-2.5 py-2 text-[11.5px] leading-4 text-text-secondary shadow-2xl"
        style={{
          left: x,
          top: above ? active.y - 12 : active.y + 16,
          transform: above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
        }}
        data-testid="chart-tip"
        data-pinned={hover ? "false" : "true"}
      >
        {content}
        <div className="mt-1 text-[10px] text-text-tertiary">{hover ? "点击锁定" : "已锁定 · 再点取消"}</div>
      </div>
    );
  };

  return {
    containerRef,
    activeId: active?.id ?? null,
    handlers: { onMouseMove, onMouseLeave: () => setHover(null), onClick },
    render,
  };
}

/** 色点（图例/提示卡片里与图形同源色的方块） */
export function ChartDot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />;
}
