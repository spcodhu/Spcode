/** 数字与时间格式化（对齐 Finch 用量页的中文计数习惯） */

/** 1.63亿 / 529万 / 79.3万 / 1,044 */
export function formatZh(n: number): string {
  if (n >= 1e8) {
    const v = n / 1e8;
    return `${trimNum(v, v >= 10 ? 2 : 2)}亿`;
  }
  if (n >= 1e4) {
    const v = n / 1e4;
    return `${trimNum(v, v >= 100 ? 0 : 1)}万`;
  }
  return n.toLocaleString("en-US");
}

function trimNum(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return s.replace(/\.0+$|(\.\d*?)0+$/, "$1");
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前 / MM-DD */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`;
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** HH:MM */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
