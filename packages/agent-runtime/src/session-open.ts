/**
 * session.open 的活跃实例复用规则。
 *
 * 桌面与手机都只是会话的观察/控制端：打开视图绝不能拥有任务生命周期。
 * 因此活跃 controller 必须原样复用，只有宿主中不存在实例时才创建。
 */
export async function getOrCreateOpenedController<T>(
  sessions: Map<string, T>,
  sessionId: string,
  create: () => Promise<T>,
): Promise<{ controller: T; reused: boolean }> {
  const existing = sessions.get(sessionId);
  if (existing) return { controller: existing, reused: true };
  const controller = await create();
  sessions.set(sessionId, controller);
  return { controller, reused: false };
}
