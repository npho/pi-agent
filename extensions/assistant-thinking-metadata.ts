import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

type Theme = {
  name?: string;
  fg(color: "dim", text: string): string;
};

type AssistantContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall" }
  | { type: string };

type AssistantMessageLike = {
  content: AssistantContent[];
  timestamp?: number | string;
  model?: string;
  thinkingLevel?: string;
  stopReason?: string;
  errorMessage?: string;
};

type AssistantRendererInternals = {
  contentContainer: Container;
  markdownTheme: ConstructorParameters<typeof Markdown>[3];
  outputPad: number;
  hasToolCalls: boolean;
  updateContent(message: AssistantMessageLike): void;
  [key: symbol]: unknown;
};

type ToolExecutionInternals = {
  toolCallId: string;
  expanded: boolean;
  render(width: number): string[];
  [key: symbol]: unknown;
};

const ORIGINAL_ASSISTANT_UPDATE = Symbol.for("assistant-thinking-metadata.original-update-content");
const ASSISTANT_RENDERER = Symbol.for("assistant-thinking-metadata.renderer");
const ORIGINAL_TOOL_RENDER = Symbol.for("assistant-thinking-metadata.original-tool-render");
const TOOL_RENDERER = Symbol.for("assistant-thinking-metadata.tool-renderer");

let activeTheme: Theme | undefined;
let currentTurnToolCalls: string[] = [];
// Preserve sibling relationships after a turn: components can rerender later.
const toolCallsById = new Map<string, string[]>();

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function isBlankLine(text: string): boolean {
  return stripAnsi(text).trim().length === 0;
}

const DEFAULT_BACKGROUND = "\x1b[49m";

/**
 * Pi's built-in dark theme paints tool boxes with explicit backgrounds. In a
 * terminal with a non-black dark background, those boxes look like black
 * rectangles. Keep their text styling but let the terminal supply the canvas.
 */
function useTerminalBackground(text: string): string {
  const withoutExplicitBackgrounds = text.replace(/\x1b\[([0-9;]*)m/g, (_match, raw: string) => {
    const params = raw === "" ? [0] : raw.split(";").map(Number);
    const kept: number[] = [];

    for (let index = 0; index < params.length; index++) {
      const param = params[index]!;
      if ((param >= 40 && param <= 49) || (param >= 100 && param <= 107)) continue;
      if (param === 48 && params[index + 1] === 5) {
        index += 2; // 48;5;<palette-index>
        continue;
      }
      if (param === 48 && params[index + 1] === 2) {
        index += 4; // 48;2;<red>;<green>;<blue>
        continue;
      }
      kept.push(param);
    }

    return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
  });
  return `${DEFAULT_BACKGROUND}${withoutExplicitBackgrounds}${DEFAULT_BACKGROUND}`;
}

function usesPiDarkTheme(): boolean {
  return activeTheme?.name === "dark" || activeTheme?.name === "system-dark";
}

function matchesTerminalBackground(lines: string[]): string[] {
  return usesPiDarkTheme() ? lines.map(useTerminalBackground) : lines;
}

/** Restore Pi's native assistant renderer, including its native thinking UI. */
function restoreAssistantMessageRenderer(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as AssistantRendererInternals;
  const original = prototype[ORIGINAL_ASSISTANT_UPDATE];
  if (typeof original === "function") {
    prototype.updateContent = original as (message: AssistantMessageLike) => void;
  }
  delete prototype[ORIGINAL_ASSISTANT_UPDATE];
  delete prototype[ASSISTANT_RENDERER];
}

function formatTimestamp(timestamp: number | string | undefined): string {
  const date = new Date(timestamp ?? Date.now());
  if (Number.isNaN(date.getTime())) return "--:-- --";
  const hour24 = date.getHours();
  const hour12 = hour24 % 12 || 12;
  return `${String(hour12).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} ${hour24 < 12 ? "a" : "p"}m`;
}

/**
 * Render a title as a single inline-Markdown line. Escaping block prefixes
 * keeps headings, lists, quotes, and fences from changing the header layout.
 */
function renderInlineMarkdownTitle(title: string, width: number, markdownTheme: ConstructorParameters<typeof Markdown>[3]): string {
  if (width <= 0) return "";
  const inlineOnly = title.replace(/^(\s*)(#{1,6}(?=\s)|[-+*](?=\s)|\d+[.)](?=\s)|>\s|`{3,}|~{3,})/, "$1\\$2");
  const rendered = new Markdown(inlineOnly, 0, 0, markdownTheme, {
    color: (text) => activeTheme?.fg("dim", text) ?? text,
  }).render(width)[0] ?? "";
  return truncateToWidth(rendered.trimEnd(), width, "");
}

function isThinkingTitle(line: string): boolean {
  // Codex emits each reasoning-step title as a standalone bold Markdown line.
  // Also accept headings so other providers get the same treatment.
  return /^\s*\*\*.+?\*\*\s*$/.test(line) || /^\s*#{1,6}\s+\S/.test(line);
}

function splitThinkingSections(thinking: string): Array<{ title: string; body: string }> {
  const lines = thinking.trim().split(/\r?\n/);
  const sections: Array<{ title: string; body: string[] }> = [];
  let current = { title: lines[0] ?? "", body: [] as string[] };

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    // A title starts a new section only after a paragraph break. This avoids
    // mistaking bold text in ordinary prose for a reasoning-step title.
    if (isThinkingTitle(line) && lines[index - 1]?.trim() === "") {
      sections.push(current);
      current = { title: line, body: [] };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);

  return sections.map(({ title, body }) => ({ title, body: body.join("\n").trim() }));
}

function thinkingHeader(
  message: AssistantMessageLike,
  title: string,
  markdownTheme: ConstructorParameters<typeof Markdown>[3],
): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      const details = `${formatTimestamp(message.timestamp)} ${message.model ?? "unknown-model"}/${message.thinkingLevel ?? "off"}`;
      // U+25CF is a one-cell solid circle: more visible than · without the
      // oversized ring treatment that some fonts give ⏺.
      const prefix = activeTheme?.fg("dim", "● ") ?? "● ";
      const styledDetails = activeTheme?.fg("dim", details) ?? details;
      const innerWidth = Math.max(0, width);
      const titleWidth = Math.max(0, innerWidth - visibleWidth(prefix) - visibleWidth(styledDetails) - 1);
      const leading = `${prefix}${renderInlineMarkdownTitle(title, titleWidth, markdownTheme)}`;
      const gap = innerWidth - visibleWidth(leading) - visibleWidth(styledDetails);
      const line = gap >= 1
        ? `${leading}${" ".repeat(gap)}${styledDetails}`
        : `${truncateToWidth(leading, Math.max(0, innerWidth - visibleWidth(styledDetails) - 1), "")} ${styledDetails}`;
      return [truncateToWidth(line, width, "")];
    },
  };
}

function renderAssistantContent(this: AssistantRendererInternals, message: AssistantMessageLike): void {
  this.contentContainer.clear();
  const visible = message.content.some((part) =>
    (part.type === "text" && part.text.trim()) || (part.type === "thinking" && part.thinking.trim()),
  );
  if (visible) this.contentContainer.addChild(new Spacer(1));

  let previousVisiblePartWasThinking = false;
  for (const part of message.content) {
    if (part.type === "text" && part.text.trim()) {
      this.contentContainer.addChild(new Markdown(part.text.trim(), this.outputPad, 0, this.markdownTheme));
      previousVisiblePartWasThinking = false;
      continue;
    }
    if (part.type !== "thinking" || !part.thinking.trim()) continue;

    // Providers can combine several titled reasoning steps into one thinking
    // content part. Render every standalone title consistently, not just the
    // first physical line of that part.
    for (const { title, body } of splitThinkingSections(part.thinking)) {
      // Keep adjacent reasoning sections distinct without accumulating the
      // multiple blank rows that Markdown/Box padding can otherwise create.
      if (previousVisiblePartWasThinking) this.contentContainer.addChild(new Spacer(1));

      const box = new Box(
        this.outputPad,
        0,
        usesPiDarkTheme() ? useTerminalBackground : undefined,
      );
      box.addChild(thinkingHeader(message, title, this.markdownTheme));
      if (body) {
        box.addChild(new Markdown(body, 0, 0, this.markdownTheme, {
          color: (text) => activeTheme?.fg("dim", text) ?? text,
        }));
      }
      this.contentContainer.addChild(box);
      previousVisiblePartWasThinking = true;
    }
  }

  this.hasToolCalls = message.content.some((part) => part.type === "toolCall");
}

function patchAssistantMessageRenderer(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as AssistantRendererInternals;
  prototype[ASSISTANT_RENDERER] = renderAssistantContent;
  if (prototype[ORIGINAL_ASSISTANT_UPDATE]) return;

  prototype[ORIGINAL_ASSISTANT_UPDATE] = prototype.updateContent;
  prototype.updateContent = function (this: AssistantRendererInternals, message: AssistantMessageLike): void {
    const renderer = (AssistantMessageComponent.prototype as unknown as AssistantRendererInternals)[ASSISTANT_RENDERER] as
      | ((this: AssistantRendererInternals, message: AssistantMessageLike) => void)
      | undefined;
    renderer?.call(this, message);
  };
}

function renderCompactTool(this: ToolExecutionInternals, width: number): string[] {
  const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionInternals;
  const original = prototype[ORIGINAL_TOOL_RENDER] as ((this: ToolExecutionInternals, width: number) => string[]) | undefined;
  if (!original) return [];

  const lines = [...original.call(this, width)];
  while (lines.length > 0 && isBlankLine(lines[0]!)) lines.shift();
  while (lines.length > 0 && isBlankLine(lines[lines.length - 1]!)) lines.pop();
  if (lines.length === 0) return lines;

  const siblingToolCalls = toolCallsById.get(this.toolCallId) ?? currentTurnToolCalls;
  const index = siblingToolCalls.indexOf(this.toolCallId);
  const marker = index >= 0 && index < siblingToolCalls.length - 1 ? " ├─" : " └─";
  const prefix = activeTheme?.fg("dim", marker) ?? marker;
  const prefixWidth = visibleWidth(prefix);

  if (this.expanded) {
    lines[0] = `${prefix}${truncateToWidth(lines[0]!, Math.max(0, width - prefixWidth))}`;
    return matchesTerminalBackground(lines.map((line) => truncateToWidth(line, width)));
  }

  const hint = activeTheme?.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`) ?? " (ctrl+o to expand)";
  const availableWidth = Math.max(0, width - prefixWidth);
  const renderedHint = truncateToWidth(hint, availableWidth);
  const callWidth = Math.max(0, availableWidth - visibleWidth(renderedHint));
  return matchesTerminalBackground([`${prefix}${truncateToWidth(lines[0]!, callWidth)}${renderedHint}`]);
}

function patchToolExecutionRenderer(): void {
  const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionInternals;
  prototype[TOOL_RENDERER] = renderCompactTool;
  if (prototype[ORIGINAL_TOOL_RENDER]) return;

  prototype[ORIGINAL_TOOL_RENDER] = prototype.render;
  prototype.render = function (this: ToolExecutionInternals, width: number): string[] {
    const renderer = (ToolExecutionComponent.prototype as unknown as ToolExecutionInternals)[TOOL_RENDERER] as
      | ((this: ToolExecutionInternals, width: number) => string[])
      | undefined;
    if (renderer) return renderer.call(this, width);
    const original = (ToolExecutionComponent.prototype as unknown as ToolExecutionInternals)[ORIGINAL_TOOL_RENDER] as
      | ((this: ToolExecutionInternals, width: number) => string[])
      | undefined;
    return original?.call(this, width) ?? [];
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("turn_start", () => {
    currentTurnToolCalls = [];
  });

  pi.on("tool_execution_start", (event) => {
    if (!currentTurnToolCalls.includes(event.toolCallId)) currentTurnToolCalls.push(event.toolCallId);
    toolCallsById.set(event.toolCallId, currentTurnToolCalls);
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // Restore the prior renderer from an earlier hot-reload before installing
    // this presentation-only header renderer.
    restoreAssistantMessageRenderer();
    activeTheme = ctx.ui.theme as Theme;
    currentTurnToolCalls = [];
    toolCallsById.clear();
    patchAssistantMessageRenderer();
    patchToolExecutionRenderer();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    return {
      message: {
        ...event.message,
        thinkingLevel: ctx.thinkingLevel,
      } as typeof event.message,
    };
  });
}
