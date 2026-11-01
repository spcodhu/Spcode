# 网络代理

设置 → 通用 → 网络代理。支持 HTTP、HTTPS、SOCKS5，填写代理地址、端口，可选用户名和密码；保存后立即生效，无需重启应用。

## 为什么不是一个 `session.setProxy()` 就结束

Spcod 的请求分布在多个互不共享的网络栈：

- Chromium：窗口资源、`session.fetch`；
- 主进程 Node：搜索/抓取测试、配额、relay HTTP；
- agent-host（utilityProcess）：AI SDK、OAuth、WebSearch、AdvancedSearch、WebFetch；
- 独立传输：relay WebSocket、飞书 REST/WS、Web Push；
- `electron-updater`：使用名为 `electron-updater` 的独立 session。

因此实现采用“一份设置 + 每个网络栈一个适配器”：

| 请求类型 | 代理入口 |
| --- | --- |
| Chromium / 更新器 | 默认 session 与 `electron-updater` session 的 `setProxy()` |
| Node `fetch` / Undici WebSocket / pi provider | Undici `ProxyAgent` + 全局 dispatcher，并安装同版本 fetch/WebSocket |
| relay `ws` | `ws` 的 `agent` 选项 |
| 飞书 REST / WS | Axios `httpAgent`/`httpsAgent` 与 `WSClient.agent` |
| Web Push | `sendNotification()` 的 `agent` 选项 |
| Bedrock / 命令行子进程 | `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（含小写形式） |
| 沙盒命令的上游连接 | sandbox-runtime `network.parentProxy`（HTTP/HTTPS） |

修改代理后，后续请求使用新 dispatcher；relay 与飞书长连接会重建，Bash 的 spawnHook 在每次执行时刷新代理环境，避免沿用会话创建时的旧配置。

## 凭据与隐私

- 密码与现有 API Key 一样保存在 `~/.spcode/settings.json`，文件权限为 `0600`。
- 渲染层只收到密码掩码；原样写回掩码时主进程恢复真实密码。
- Chromium 的 `proxyRules` 不含密码，认证经 `app.login` 回调提供。
- 代理 URL 不应写日志；标准命令行环境变量会包含运行时代理 URL，能读取进程环境的本机程序仍可读取它。

## 边界

- 控制的是桌面应用自己的出站请求。手机 PWA 的浏览器请求、`shell.openExternal()` 打开的外部浏览器、tailscaled 与独立 relay 服务不继承此设置。
- 任意第三方 CLI、MCP 或扩展是否走代理由其自身决定；标准命令行工具通常遵循上述环境变量。
- Chromium 对 SOCKS5 用户名/密码认证的支持受限；需要全链路代理认证时推荐使用 HTTP/HTTPS 代理。SOCKS5 下沙盒命令由子进程通过 `ALL_PROXY` 自行处理。
- 切换代理不会中断正在进行的 AI 流式响应；旧 dispatcher 优雅关闭，新请求走新配置。
