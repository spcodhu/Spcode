import { baseName, type SessionMeta } from "@spcode/shared";
import { useTranslation } from "react-i18next";

export interface ProjectOption {
  cwd: string;
  name: string;
  updatedAt: number;
}

/** 从 PC 注册表镜像提取项目空间：同 cwd 去重，最近使用的项目优先。 */
export function collectProjectOptions(sessions: SessionMeta[]): ProjectOption[] {
  const byCwd = new Map<string, ProjectOption>();
  for (const session of sessions) {
    if (session.mode !== "project" || !session.cwd.trim()) continue;
    const cwd = session.cwd.trim();
    const current = byCwd.get(cwd);
    if (!current || session.updatedAt > current.updatedAt) {
      byCwd.set(cwd, { cwd, name: baseName(cwd) || cwd, updatedAt: session.updatedAt });
    }
  }
  return [...byCwd.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd),
  );
}

export function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: ProjectOption[];
  value: string;
  onChange: (cwd: string) => void;
}) {
  const { t } = useTranslation("mobile");
  if (projects.length === 0) {
    return (
      <div
        data-testid="project-options-empty"
        className="rounded-xl border border-border bg-bg-elevated px-3.5 py-3 text-xs leading-5 text-text-tertiary"
      >
        {t("sessions.noProjects")}
      </div>
    );
  }
  return (
    <div
      role="listbox"
      aria-label={t("sessions.selectProject")}
      data-testid="project-options"
      className="thin-scroll max-h-56 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-bg-main/60 p-1.5"
    >
      {projects.map((project) => {
        const selected = project.cwd === value;
        return (
          <button
            key={project.cwd}
            type="button"
            role="option"
            aria-selected={selected}
            data-testid="project-option"
            data-cwd={project.cwd}
            onClick={() => onChange(project.cwd)}
            className={`flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
              selected ? "border-accent bg-accent-soft" : "border-transparent hover:bg-bg-hover"
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text-primary">{project.name}</span>
              <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-text-tertiary">
                {project.cwd}
              </span>
            </span>
            <span aria-hidden="true" className={`shrink-0 text-sm ${selected ? "text-accent" : "text-transparent"}`}>
              ✓
            </span>
          </button>
        );
      })}
    </div>
  );
}
