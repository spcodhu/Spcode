export interface LayoutWidths {
  sidebar: number;
  plan: number;
}

export const DEFAULT_LAYOUT_WIDTHS: LayoutWidths = { sidebar: 248, plan: 560 };
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const PLAN_MIN_WIDTH = 320;
export const PLAN_MAX_WIDTH = 760;
export const CENTER_MIN_WIDTH = 320;
export const LAYOUT_STORAGE_KEY = "spcode.layout.widths";

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

function finiteWidth(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 非法/旧 localStorage 数据回退默认值，不让坏值破坏整页布局。 */
export function parseLayoutWidths(raw: string | null): LayoutWidths {
  if (!raw) return { ...DEFAULT_LAYOUT_WIDTHS };
  try {
    const value = JSON.parse(raw) as Partial<LayoutWidths>;
    return {
      sidebar: finiteWidth(value.sidebar, DEFAULT_LAYOUT_WIDTHS.sidebar),
      plan: finiteWidth(value.plan, DEFAULT_LAYOUT_WIDTHS.plan),
    };
  } catch {
    return { ...DEFAULT_LAYOUT_WIDTHS };
  }
}

/** 在窗口可用宽度内约束侧栏/计划栏，始终给中间会话区留出最小空间。 */
export function constrainLayoutWidths(input: LayoutWidths, totalWidth: number, planOpen: boolean): LayoutWidths {
  const handles = planOpen ? 16 : 8;
  const sidebarMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, totalWidth - (planOpen ? PLAN_MIN_WIDTH : 0) - CENTER_MIN_WIDTH - handles),
  );
  const sidebar = clamp(input.sidebar, SIDEBAR_MIN_WIDTH, sidebarMax);
  if (!planOpen) return { sidebar, plan: input.plan };
  const planMax = Math.max(PLAN_MIN_WIDTH, Math.min(PLAN_MAX_WIDTH, totalWidth - sidebar - CENTER_MIN_WIDTH - handles));
  return { sidebar, plan: clamp(input.plan, PLAN_MIN_WIDTH, planMax) };
}

export function sidebarRange(totalWidth: number, planWidth: number, planOpen: boolean): [number, number] {
  const max = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, totalWidth - (planOpen ? planWidth : 0) - CENTER_MIN_WIDTH - (planOpen ? 16 : 8)),
  );
  return [SIDEBAR_MIN_WIDTH, max];
}

export function planRange(totalWidth: number, sidebarWidth: number): [number, number] {
  const max = Math.max(PLAN_MIN_WIDTH, Math.min(PLAN_MAX_WIDTH, totalWidth - sidebarWidth - CENTER_MIN_WIDTH - 16));
  return [PLAN_MIN_WIDTH, max];
}
