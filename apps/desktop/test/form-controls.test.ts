import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const renderer = join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith(".tsx") ? [file] : [];
  });
}

function unstyledControls(source: string): number[] {
  const file = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const classes = new Map<string, string>();
  const findings: number[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      classes.set(node.name.getText(file), node.initializer.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(file);
      if (["input", "textarea", "select"].includes(tag)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const type = attributes.find((attribute) => attribute.name.getText(file) === "type")?.initializer;
        if (type && ts.isStringLiteral(type) && ["checkbox", "radio", "file", "hidden", "range"].includes(type.text)) {
          return;
        }
        const initializer = attributes.find((attribute) => attribute.name.getText(file) === "className")?.initializer;
        const className = (initializer?.getText(file) ?? "").replace(/\binputCls\b/g, classes.get("inputCls") ?? "");
        if (!/\b(form-control|field-input|composer-textarea)\b/.test(className)) {
          findings.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

describe("桌面输入控件样式契约", () => {
  it("能识别遗漏的输入框，保留复选框与聊天编辑器的独立布局", () => {
    expect(unstyledControls("<input /><textarea /><select />")).toEqual([1, 1, 1]);
    expect(unstyledControls('<input type="checkbox" /><textarea className="composer-textarea" />')).toEqual([]);
    expect(unstyledControls('const inputCls = "form-control"; <input className={inputCls} />')).toEqual([]);
  });

  it("所有桌面文本控件都使用统一表单或组合输入样式", () => {
    const findings = sources(renderer).flatMap((file) =>
      unstyledControls(readFileSync(file, "utf8")).map((line) => `${relative(renderer, file)}:${line}`),
    );
    expect(findings).toEqual([]);
  });

  it("输入框共用间距与柔和焦点反馈，不再套用按钮的黑色 outline", () => {
    const css = readFileSync(join(renderer, "styles.css"), "utf8");
    expect(css).toMatch(/\.form-control,\s*\.field-input\s*\{[^}]*min-height: 36px;[^}]*padding: 7px 12px;/);
    expect(css).toMatch(/\.form-control:focus,\s*\.field-group:focus-within\s*\{[^}]*var\(--color-border-strong\)/);
    expect(css).toContain("button:not(.form-control):focus-visible");
    expect(css).not.toMatch(/(?:^|\n)(?:input|textarea|select):focus-visible/);
    expect(css).toContain('.form-control[aria-invalid="true"]');
    expect(css).toContain("color-mix(in srgb, var(--color-border-strong) 25%, transparent)");
  });
});
