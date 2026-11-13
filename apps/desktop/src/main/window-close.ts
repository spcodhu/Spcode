import type { WindowCloseAction } from "@spcode/shared";

export type WindowCloseRequest = "allow" | "confirm" | "wait";
export type WindowCloseResolution = WindowCloseAction | "ignore";

/** Windows 窗口关闭状态机：应用主动退出不拦截，用户点叉必须先确认。 */
export class WindowCloseController {
  private confirmationOpen = false;
  private closeAllowed = false;

  request(platform: NodeJS.Platform): WindowCloseRequest {
    if (platform !== "win32" || this.closeAllowed) return "allow";
    if (this.confirmationOpen) return "wait";
    this.confirmationOpen = true;
    return "confirm";
  }

  resolve(action: WindowCloseAction): WindowCloseResolution {
    if (!this.confirmationOpen) return "ignore";
    this.confirmationOpen = false;
    if (action === "quit") this.closeAllowed = true;
    return action;
  }

  /** app.quit / 自动更新安装会触发 before-quit，不能再被窗口确认框挡住。 */
  allowWithoutConfirmation(): void {
    this.closeAllowed = true;
  }
}
