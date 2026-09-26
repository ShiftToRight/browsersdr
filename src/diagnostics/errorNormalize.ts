import type { DiagnosticEventInput } from "./diagnosticTypes";

const MAX_MESSAGE = 500;
const MAX_STACK_LINES = 12;

function stripSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; }
      catch { return "[url removed]"; }
    })
    .replace(/(?:serial(?:number)?|filename|path)\s*[:=]\s*[^\s,;]+/gi, "$1=[removed]")
    .slice(0, MAX_MESSAGE);
}

function applicationStack(stack: string | undefined): string[] | undefined {
  if (!stack) return undefined;
  const origin = typeof location === "undefined" ? "" : location.origin;
  const frames = stack.split("\n").slice(1).map((line) => stripSensitiveText(line.trim()))
    .filter((line) => !line.includes("chrome-extension://") && !line.includes("moz-extension://"))
    .filter((line) => !origin || line.includes(origin) || line.includes("/assets/") || line.includes("src/"))
    .slice(0, MAX_STACK_LINES);
  return frames.length ? frames : undefined;
}

export function normalizeDiagnosticError(input: DiagnosticEventInput): {
  errorName?: string;
  safeMessage?: string;
  safeStack?: string[];
} {
  if (input.error instanceof Error) {
    return {
      errorName: stripSensitiveText(input.error.name || "Error"),
      safeMessage: stripSensitiveText(input.safeMessage ?? input.error.message),
      safeStack: applicationStack(input.error.stack),
    };
  }
  const message = input.safeMessage ?? (input.error === undefined ? undefined : String(input.error));
  return message ? { safeMessage: stripSensitiveText(message) } : {};
}
