import type { LocalizedText } from "./i18n/types.js";

export interface QuestionOption {
  /** Protocol value, independent of the visible label. */
  value: string;
  label: string;
  description?: string;
  /** Only app-owned text has translation descriptors; model text stays verbatim. */
  presentation?: { label?: LocalizedText; description?: LocalizedText };
}

export interface QuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
  presentation?: { question?: LocalizedText; header?: LocalizedText };
}

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  questions: QuestionItem[];
  purpose?: "plan-approval";
}

export type QuestionAnswer =
  | { kind: "options"; values: string[] }
  | { kind: "text"; text: string }
  | { kind: "dismiss" };

/** Keys are zero-based question indices, never question text. */
export type QuestionAnswers = Record<string, QuestionAnswer>;

type MessageRenderer = (message: LocalizedText) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate against the original pending request, not translated labels or caller-provided options.
 * null means malformed: callers must NOT consume the pending request in that case.
 * Missing indices (including {}) mean unanswered, never approval.
 */
export function validateQuestionAnswers(request: QuestionRequest, input: unknown): QuestionAnswers | null {
  if (!isRecord(input)) return null;
  const answers: QuestionAnswers = {};
  for (const [key, answer] of Object.entries(input)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) return null;
    const question = request.questions[Number(key)];
    if (!question || !isRecord(answer)) return null;
    switch (answer.kind) {
      case "options": {
        if (Object.keys(answer).some((k) => k !== "kind" && k !== "values")) return null;
        const values = answer.values;
        if (!Array.isArray(values) || values.length === 0 || (!question.multiSelect && values.length !== 1)) {
          return null;
        }
        if (new Set(values).size !== values.length) return null;
        if (
          values.some(
            (value) =>
              typeof value !== "string" || question.options?.filter((option) => option.value === value).length !== 1,
          )
        ) {
          return null;
        }
        answers[key] = { kind: "options", values: [...values] };
        break;
      }
      case "text":
        if (typeof answer.text !== "string" || Object.keys(answer).some((k) => k !== "kind" && k !== "text")) {
          return null;
        }
        answers[key] = { kind: "text", text: answer.text };
        break;
      case "dismiss":
        if (Object.keys(answer).length !== 1) return null;
        answers[key] = { kind: "dismiss" };
        break;
      default:
        return null;
    }
  }
  return answers;
}

/** Render with original request labels by default (canonical English for app-owned text). */
export function formatQuestionAnswer(
  question: QuestionItem,
  answer: QuestionAnswer | undefined,
  render?: MessageRenderer,
): string {
  if (!answer || answer.kind === "dismiss") return "";
  if (answer.kind === "text") return answer.text;
  return answer.values
    .map((value) => {
      const option = question.options?.find((o) => o.value === value);
      return option ? (render && option.presentation?.label ? render(option.presentation.label) : option.label) : "";
    })
    .join(", ");
}

export function formatQuestionAnswers(request: QuestionRequest, input: unknown): string {
  const answers = validateQuestionAnswers(request, input);
  if (!answers) return "";
  return request.questions
    .flatMap((question, i) => {
      const answer = answers[String(i)];
      if (!answer || answer.kind === "dismiss") return [];
      return [`Q: ${question.question}\nA: ${formatQuestionAnswer(question, answer)}`];
    })
    .join("\n\n");
}

export function dismissQuestionAnswers(request: QuestionRequest): QuestionAnswers {
  return Object.fromEntries(request.questions.map((_, i) => [String(i), { kind: "dismiss" } as const]));
}

/** Shared desktop/mobile draft semantics: non-blank free text overrides shortcuts, but stays verbatim. */
export function buildQuestionAnswers(
  request: QuestionRequest,
  selected: Record<string, string[]>,
  freeText: Record<string, string>,
): QuestionAnswers {
  return Object.fromEntries(
    request.questions.map((_, i) => {
      const key = String(i);
      const text = freeText[key];
      const values = selected[key];
      const answer: QuestionAnswer = text?.trim()
        ? { kind: "text", text }
        : values?.length
          ? { kind: "options", values: [...values] }
          : { kind: "dismiss" };
      return [key, answer];
    }),
  );
}
