/**
 * 文件附件拼接（纯逻辑，无 UI 依赖）：
 * MD 输入模式下选择的文本文件，发送时以 <file> 块拼接到消息文本末尾
 * （引擎 prompt 只支持文本+图片，文件内容随文本发出）。
 */

/** 待发送的文件附件（文本内容已读入） */
export interface DraftFile {
  name: string;
  size: number;
  text: string;
}

/** 文件扩展名 → markdown 代码块语言（未知不标，高亮器会忽略） */
export function langOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "py",
    java: "java",
    go: "go",
    rs: "rs",
    rb: "rb",
    php: "php",
    swift: "swift",
    kt: "kt",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "cs",
    md: "md",
    markdown: "md",
    json: "json",
    jsonc: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    vue: "vue",
    svelte: "svelte",
    csv: "csv",
    ini: "ini",
    conf: "ini",
    txt: "",
    log: "",
  };
  return map[ext] ?? "";
}

/** 文件附件拼接为 <file> 块（内容含 ``` 时升级四反引号围栏） */
export function buildFileBlocks(files: DraftFile[]): string {
  return files
    .map((f) => {
      const fence = f.text.includes("```") ? "````" : "```";
      return `\n\n<file name="${f.name}">\n${fence}${langOf(f.name)}\n${f.text.replace(/\s+$/, "")}\n${fence}\n</file>`;
    })
    .join("");
}
