# @spcode/shared

主进程 / preload / 渲染进程 / agent-host 之间共享的类型与协议定义。
纯 TypeScript，零依赖，不引用任何运行时 API（Node/Electron/DOM 都不可），
保证可以被任意一端安全 import。
