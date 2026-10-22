import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const visibleAttributes = new Set(["title", "placeholder", "aria-label", "alt", "label", "subtitle"]);
const technicalLabels = new Set([
  "Spcod",
  "Spcode",
  "MCP",
  "JSON",
  "API Key",
  "API",
  "URL",
  "Token",
  "Tokens",
  "HTTP",
  "HTTPS",
  "WebSocket",
  "Base URL",
  "App ID",
  "App Secret",
  "open_id",
  "Tailscale",
  "Web Push",
  "Markdown",
  "Bing",
  "Tavily",
  "Bocha",
  "GitHub",
  "Pi",
  "Shell",
  "Ctrl",
  "Cmd",
  "Shift",
  "Enter",
  "Esc",
  "MB",
  "KB",
  "GB",
  "%",
  "px",
]);

function naturalText(value: string): boolean {
  const text = value.trim().replace(/\s+/g, " ");
  const identifier = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|@[^/\s]+\/[\w.-]+|v\d+\.\d+\.\d+ \(MIT\))$/i.test(text);
  return /[\p{L}]/u.test(text) && !technicalLabels.has(text) && !identifier && !/^[\d\s.,+%/×→·–—-]+$/.test(text);
}

function visibleLiterals(source: string): string[] {
  const file = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    if (naturalText(text))
      found.push(
        `${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${text.trim().replace(/\s+/g, " ")}`,
      );
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    if (
      ts.isJsxAttribute(node) &&
      visibleAttributes.has(node.name.getText(file)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    )
      report(node, node.initializer.text);
    if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression))
      report(node, node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith(".tsx") ? [file] : [];
  });
}

describe("application-owned visible text", () => {
  it("detects both languages but not translated expressions or technical labels", () => {
    expect(visibleLiterals('<button title="Copy">复制</button>')).toHaveLength(2);
    expect(visibleLiterals('<button>{t("copy")}</button><label>API Key</label>')).toEqual([]);
    expect(visibleLiterals('<input placeholder="Search sessions" />')).toHaveLength(1);
    expect(visibleLiterals("<pre>{userContent}</pre>")).toEqual([]);
  });

  it("keeps UI literals in translation catalogs", () => {
    const findings = ["apps/desktop/src/renderer/src", "apps/mobile/src"]
      .flatMap((dir) => sources(join(root, dir)))
      .flatMap((file) => visibleLiterals(readFileSync(file, "utf8")).map((item) => `${relative(root, file)}:${item}`));
    expect(findings).toEqual([]);
  });
});
