import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type HeadersRecord = Record<string, string | string[] | undefined>;

type RateLimitWindow = {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
};

type RateLimitSnapshot = {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
};

// Claude Opus 4 pricing per million tokens (fallback for local/free models)
const OPUS_COSTS = {
  input: 5,           // $5.00 per 1M input tokens
  output: 25,         // $25.00 per 1M output tokens
  cacheRead: 0.5,     // $0.50 per 1M cache read tokens
  cacheWrite: 6.25,   // $6.25 per 1M cache write tokens
};

/** Calculate Opus-equivalent cost from token counts */
function computeOpusCost(input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return (
    (input / 1_000_000) * OPUS_COSTS.input +
    (output / 1_000_000) * OPUS_COSTS.output +
    (cacheRead / 1_000_000) * OPUS_COSTS.cacheRead +
    (cacheWrite / 1_000_000) * OPUS_COSTS.cacheWrite
  );
}

type ModelLike = {
  api?: string;
  provider?: string;
  id?: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
};

const STATUS_KEY = "openai-token-limits";

// Temporary display toggle: set to true to restore R… and CH… footer stats.
const SHOW_CACHE_STATS = false;

let latestSnapshot: RateLimitSnapshot | undefined;
let lastModel: ModelLike | undefined;
let lastStatus = "extension loaded; no provider response seen yet";
let lastHeaders: string[] = [];
let requestFooterRender: (() => void) | undefined;

function asModel(model: unknown): ModelLike | undefined {
  return model && typeof model === "object" ? (model as ModelLike) : undefined;
}

function isOpenAICodexModel(model: unknown): model is ModelLike {
  const record = asModel(model);
  if (!record) return false;

  const api = String(record.api ?? "").toLowerCase();
  const provider = String(record.provider ?? "").toLowerCase();
  const id = String(record.id ?? "").toLowerCase();
  const name = String(record.name ?? "").toLowerCase();

  return (
    api === "openai-codex-responses" ||
    api.includes("codex") ||
    provider.includes("codex") ||
    id.includes("codex") ||
    name.includes("codex")
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (visibleWidth(text) <= width) return text;
  const plain = stripAnsi(text);
  if (width <= visibleWidth(ellipsis)) return plain.slice(0, width);
  return `${plain.slice(0, width - visibleWidth(ellipsis))}${ellipsis}`;
}

function padAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function boxLine(content: string, innerWidth: number): string {
  return `│ ${padAnsi(truncateToWidth(content, innerWidth), innerWidth)} │`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function headerValue(headers: HeadersRecord, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function headerNumber(headers: HeadersRecord, name: string): number | undefined {
  const value = headerValue(headers, name);
  if (value === undefined || value.trim() === "") return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function parseWindow(headers: HeadersRecord, prefix: string, scope: "primary" | "secondary"): RateLimitWindow | undefined {
  const usedPercent = headerNumber(headers, `${prefix}-${scope}-used-percent`);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: headerNumber(headers, `${prefix}-${scope}-window-minutes`),
    resetsAt: headerNumber(headers, `${prefix}-${scope}-reset-at`),
  };
}

function parseSnapshot(headers: HeadersRecord): RateLimitSnapshot | undefined {
  const prefixes = new Set<string>(["x-codex"]);
  for (const key of Object.keys(headers ?? {})) {
    const lowerKey = key.toLowerCase();
    const suffix = "-primary-used-percent";
    if (lowerKey.startsWith("x-") && lowerKey.endsWith(suffix)) {
      prefixes.add(lowerKey.slice(0, -suffix.length));
    }
  }

  const windows: RateLimitWindow[] = [];
  for (const prefix of prefixes) {
    const primary = parseWindow(headers, prefix, "primary");
    const secondary = parseWindow(headers, prefix, "secondary");
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
  }

  if (windows.length === 0) return undefined;

  const findByMinutes = (target: number, tolerance: number) =>
    windows.find((window) =>
      typeof window.windowMinutes === "number" ? Math.abs(window.windowMinutes - target) <= tolerance : false,
    );

  return {
    primary: findByMinutes(300, 15) ?? windows[0],
    secondary: findByMinutes(10080, 120) ?? windows.find((window) => window !== windows[0]),
  };
}

function rgbForRemainingPercent(remainingPercent: number): { r: number; g: number; b: number } {
  const pct = Math.max(0, Math.min(100, remainingPercent));
  const t = pct / 100;

  if (t < 0.5) {
    const local = t / 0.5;
    return { r: 220, g: Math.round(150 * local), b: 0 };
  }

  const local = (t - 0.5) / 0.5;
  return { r: Math.round(220 * (1 - local)), g: Math.round(150 + 30 * local), b: 0 };
}

type ResetWindowKind = "5h" | "1w";

function resetKindForLabel(label: string): ResetWindowKind {
  return label === "1w" ? "1w" : "5h";
}

function resetFieldWidth(kind: ResetWindowKind): number {
  return kind === "1w" ? 10 : 6;
}

function formatRemainingPercentField(remainingPercent: number): string {
  return `${Math.round(remainingPercent)}%`.padStart(4, " ");
}

function usageBarWidth(label: string): number {
  return label.length + 1 + 4 + 1 + resetFieldWidth(resetKindForLabel(label));
}

function resetAtMs(window: RateLimitWindow | undefined): number | undefined {
  if (!window?.resetsAt || !Number.isFinite(window.resetsAt)) return undefined;
  return window.resetsAt > 1_000_000_000_000 ? window.resetsAt : window.resetsAt * 1000;
}

function remainingResetMinutes(window: RateLimitWindow | undefined): number | undefined {
  const ms = resetAtMs(window);
  if (ms === undefined) return undefined;
  return Math.max(0, Math.ceil((ms - Date.now()) / 60000));
}

function formatResetCountdown(window: RateLimitWindow | undefined, kind: ResetWindowKind): string | undefined {
  const totalMinutes = remainingResetMinutes(window);
  if (totalMinutes === undefined) return undefined;

  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (kind === "5h") return `${hours}h ${minutes}m`;

  const days = Math.floor(totalMinutes / 1440);
  return `${days}d ${hours}h ${minutes}m`;
}

function formatResetCountdownField(window: RateLimitWindow | undefined, kind: ResetWindowKind): string {
  const width = resetFieldWidth(kind);
  return (formatResetCountdown(window, kind) ?? "").padStart(width, " ");
}

// MANUAL APPEARANCE TOGGLE: set this to false if the / end caps look
// wrong (missing-glyph boxes) in your terminal. They require a Nerd Font.
// The partial-block meter body remains fully functional either way.
const USE_NERD_FONT_PILL_CAPS = false;

// Number of terminal cells in the progress body. Each cell has eight partial
// block states, so this 8-cell meter has 64 visual levels (~1.56% each).
const METER_WIDTH = 8;
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function meter(remainingPercent: number): string {
  const { r, g, b } = rgbForRemainingPercent(remainingPercent);
  const progress = Math.max(0, Math.min(100, remainingPercent));
  const eighths = Math.round((progress / 100) * METER_WIDTH * 8);
  const filled = Math.floor(eighths / 8);
  const partial = PARTIAL_BLOCKS[eighths % 8] ?? "";
  const empty = METER_WIDTH - filled - (partial ? 1 : 0);
  const leftCap = USE_NERD_FONT_PILL_CAPS ? "" : "";
  const rightCap = USE_NERD_FONT_PILL_CAPS ? "" : "";
  const used = "100;100;100";

  // Use background-colored cells for the solid regions. Foreground glyphs
  // (█ and ░) leave terminal-background gaps between the body and curved caps,
  // which can look like a third, white line. A partial glyph is drawn with the
  // remaining color over the used-color background, so it is the only mixed cell.
  const remainingCells = `\x1b[48;2;${r};${g};${b}m${" ".repeat(filled)}`;
  const partialCell = partial ? `\x1b[38;2;${r};${g};${b}m\x1b[48;2;${used}m${partial}` : "";
  const usedCells = `\x1b[48;2;${used}m${" ".repeat(empty)}`;
  const closingCap = rightCap ? `\x1b[49m\x1b[38;2;${used}m${rightCap}` : "";

  return `\x1b[38;2;${r};${g};${b}m${leftCap}${remainingCells}${partialCell}${usedCells}${closingCap}\x1b[0m`;
}

function badge(label: string, window: RateLimitWindow | undefined): string | undefined {
  if (!window) return undefined;
  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const remaining = `${Math.round(remainingPercent)}%`;
  const reset = formatResetCountdown(window, resetKindForLabel(label));
  return reset ? `${remaining} ${meter(remainingPercent)} ${reset}` : `${remaining} ${meter(remainingPercent)}`;
}

function renderStatus(snapshot: RateLimitSnapshot): string | undefined {
  // Temporarily hide the legacy/uncertain 5h window. Keep parsing it for
  // diagnostics, but display only the right-most (secondary / weekly) limit.
  return badge("1w", snapshot.secondary);
}

function formatLimitLine(label: string, window: RateLimitWindow | undefined): string {
  if (!window) return `${label}: unavailable`;

  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const resetMs = resetAtMs(window);
  const reset = resetMs !== undefined ? `, resets ${new Date(resetMs).toLocaleString()}` : "";
  const windowText = window.windowMinutes ? ` (${window.windowMinutes} min window)` : "";
  return `${label}: ${remainingPercent.toFixed(0)}% remaining, ${window.usedPercent.toFixed(0)}% used${windowText}${reset}`;
}

function formatResetAt(window: RateLimitWindow | undefined): string {
  const ms = resetAtMs(window);
  if (ms === undefined) return "reset unknown";
  return `resets ${new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function centered(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (plain.length >= width) return plain.slice(0, width);
  const left = Math.floor((width - plain.length) / 2);
  return `${" ".repeat(left)}${plain}${" ".repeat(width - plain.length - left)}`;
}

function usageBarContent(label: string, window: RateLimitWindow, width: number): string {
  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const remaining = formatRemainingPercentField(remainingPercent);
  const reset = formatResetCountdownField(window, resetKindForLabel(label));
  return truncateToWidth(`${label} ${remaining} ${reset}`, width, "").padEnd(width, " ");
}

function usageBar(label: string, window: RateLimitWindow | undefined, width = usageBarWidth(label)): string {
  if (!window) return `\x1b[48;2;80;80;80m\x1b[38;2;255;255;255m${centered(`${label} unavailable`, width)}\x1b[0m`;

  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const { r, g, b } = rgbForRemainingPercent(remainingPercent);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fg = luminance > 115 ? "0;0;0" : "255;255;255";
  return `\x1b[48;2;${r};${g};${b}m\x1b[38;2;${fg}m${usageBarContent(label, window, width)}\x1b[0m`;
}

function usageBarLine(label: string, window: RateLimitWindow | undefined, barWidth: number): string {
  return `${usageBar(label, window, barWidth)}  ${formatResetAt(window)}`;
}

function modelSummary(model: ModelLike | undefined): string {
  if (!model) return "no model";
  return `${model.provider ?? "?"}/${model.id ?? model.name ?? "?"} api=${model.api ?? "?"}`;
}

function getAssistantUsage(entry: unknown):
  | { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
  | undefined {
  const record = entry as { type?: string; message?: { role?: string; usage?: any } };
  if (record.type !== "message" || record.message?.role !== "assistant") return undefined;
  const usage = record.message.usage;
  if (!usage) return undefined;
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    cacheRead: Number(usage.cacheRead ?? 0),
    cacheWrite: Number(usage.cacheWrite ?? 0),
    cost: Number(usage.cost?.total ?? 0),
  };
}

function installInlineFooter(ctx: any, getThinkingLevel: () => string) {
  ctx.ui.setStatus(STATUS_KEY, undefined);

  ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
    requestFooterRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender()) ?? (() => {});
    const resetTimer = setInterval(() => tui.requestRender(), 30_000);
    resetTimer.unref?.();

    return {
      dispose() {
        if (requestFooterRender) requestFooterRender = undefined;
        clearInterval(resetTimer);
        unsubscribe();
      },
      invalidate() {},
      render(width: number): string[] {
        const model = asModel(ctx.model);
        lastModel = model;

        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        let latestCacheHitRate: number | undefined;

        for (const entry of ctx.sessionManager.getEntries()) {
          const usage = getAssistantUsage(entry);
          if (!usage) continue;
          totalInput += usage.input;
          totalOutput += usage.output;
          totalCacheRead += usage.cacheRead;
          totalCacheWrite += usage.cacheWrite;
          totalCost += usage.cost;
          const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
          latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
        }

        let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
        const branch = footerData.getGitBranch?.();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName?.();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(theme.fg("dim", `↑${formatTokens(totalInput)}`));
        if (totalOutput) statsParts.push(theme.fg("dim", `↓${formatTokens(totalOutput)}`));
        if (SHOW_CACHE_STATS) {
          if (totalCacheRead) statsParts.push(theme.fg("dim", `R${formatTokens(totalCacheRead)}`));
          if (totalCacheWrite) statsParts.push(theme.fg("dim", `W${formatTokens(totalCacheWrite)}`));
          if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
            statsParts.push(theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`));
          }
        }

        // Always show cost: use actual API cost if available, otherwise
        // fall back to Opus-equivalent pricing for local/free models.
        const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth?.(model) : false;
        let costStr = "";
        if (totalCost > 0) {
          // Real API cost (Claude, OpenAI, etc.)
          const displayedCost = Math.ceil(totalCost * 100 - Number.EPSILON) / 100;
          costStr = `$${displayedCost.toFixed(2)}`;
        } else if (totalInput || totalOutput || totalCacheRead || totalCacheWrite) {
          // Local/free model: show Opus-equivalent cost
          const opusCost = computeOpusCost(totalInput, totalOutput, totalCacheRead, totalCacheWrite);
          costStr = `$${opusCost.toFixed(2)}`;
        }
        if (costStr || usingSubscription) {
          statsParts.push(theme.fg("dim", costStr || "$0.00"));
        }

        const contextUsage = ctx.getContextUsage?.();
        const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
        const contextDisplay =
          contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
        if (contextPercentValue > 90) {
          statsParts.push(theme.fg("error", contextDisplay));
        } else if (contextPercentValue > 70) {
          statsParts.push(theme.fg("warning", contextDisplay));
        } else {
          statsParts.push(theme.fg("dim", contextDisplay));
        }

        if (model && isOpenAICodexModel(model) && latestSnapshot) {
          const status = renderStatus(latestSnapshot);
          if (status) statsParts.push(status);
        }

        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        const modelName = model?.id || "no-model";
        let rightSideWithoutProvider = modelName;
        if (model?.reasoning) {
          const thinkingLevel = getThinkingLevel() || "off";
          rightSideWithoutProvider =
            thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }

        let rightSide = rightSideWithoutProvider;
        if (footerData.getAvailableProviderCount?.() > 1 && model) {
          rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
          if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) rightSide = rightSideWithoutProvider;
        }
        rightSide = theme.fg("dim", rightSide);

        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
        let statsLine: string;
        if (totalNeeded <= width) {
          statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
        } else {
          const availableForRight = width - statsLeftWidth - 2;
          statsLine = availableForRight > 0 ? statsLeft + "  " + truncateToWidth(rightSide, availableForRight, "") : statsLeft;
        }

        const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), statsLine];

        const extensionStatuses = footerData.getExtensionStatuses?.();
        if (extensionStatuses?.size > 0) {
          const statuses = Array.from(extensionStatuses.entries())
            .filter(([key]) => key !== STATUS_KEY)
            .sort(([a], [b]) => String(a).localeCompare(String(b)))
            .map(([, text]) => sanitizeStatusText(String(text)));
          if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
        }

        return lines;
      },
    };
  });
}

export default function openaiTokenLimits(pi: ExtensionAPI) {
  const updateStatus = (ctx: any) => {
    lastModel = asModel(ctx.model);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    requestFooterRender?.();
  };

  pi.registerCommand("status", {
    description: "Show OpenAI Codex token limit status",
    handler: async (_args, ctx) => {
      updateStatus(ctx);

      const model = asModel(ctx.model) ?? lastModel;
      const isCodex = isOpenAICodexModel(model);
      const snapshot = latestSnapshot;
      const plainLines = snapshot
        ? [formatLimitLine("1w", snapshot.secondary)]
        : [
            "No OpenAI Codex token-limit data has been captured yet.",
            "Send one Codex request using SSE transport, then run /status again.",
          ];

      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          [
            "OpenAI Codex token limits",
            `Model: ${modelSummary(model)}`,
            `Codex model: ${isCodex}`,
            ...plainLines,
            `Last status: ${lastStatus}`,
          ].join("\n"),
          snapshot ? "info" : "warning",
        );
        return;
      }

      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => ({
          invalidate() {},
          handleInput() {
            done(undefined);
          },
          render(width: number): string[] {
            const popupWidth = Math.max(20, Math.min(width, 96));
            const innerWidth = popupWidth - 4;
            // const primaryBarWidth = usageBarWidth("5h"); // 5h window temporarily hidden
            const secondaryBarWidth = usageBarWidth("1w");
            const title = theme.bold(theme.fg(snapshot ? "success" : "warning", "OpenAI Codex token limits"));
            const hint = theme.fg("dim", "Press any key to close");
            const lines = [
              `┌${"─".repeat(popupWidth - 2)}┐`,
              boxLine(title, innerWidth),
              `├${"─".repeat(popupWidth - 2)}┤`,
              boxLine(`Model: ${modelSummary(model)}`, innerWidth),
              boxLine(`Codex model: ${isCodex}`, innerWidth),
              boxLine("", innerWidth),
            ];

            if (snapshot) {
              // lines.push(boxLine(usageBarLine("5h", snapshot.primary, primaryBarWidth), innerWidth));
              lines.push(boxLine(usageBarLine("1w", snapshot.secondary, secondaryBarWidth), innerWidth));
              lines.push(boxLine("", innerWidth));
              for (const line of plainLines) lines.push(boxLine(theme.fg("dim", line), innerWidth));
            } else {
              for (const line of plainLines) lines.push(boxLine(line, innerWidth));
            }

            lines.push(boxLine("", innerWidth));
            lines.push(boxLine(theme.fg("dim", `Last status: ${lastStatus}`), innerWidth));
            if (lastHeaders.length > 0) lines.push(boxLine(theme.fg("dim", `Headers: ${lastHeaders.join(", ")}`), innerWidth));
            lines.push(boxLine(hint, innerWidth));
            lines.push(`└${"─".repeat(popupWidth - 2)}┘`);
            return lines;
          },
        }),
        { overlay: true, overlayOptions: { anchor: "center", width: 72, maxHeight: 18, margin: 1 } },
      );
    },
  });

  pi.registerCommand("openai-limits-debug", {
    description: "Show OpenAI Codex token-limit extension diagnostics",
    handler: async (_args, ctx) => {
      updateStatus(ctx);
      ctx.ui.notify(
        [
          `openai-token-limits: ${lastStatus}`,
          `model: ${modelSummary(asModel(ctx.model) ?? lastModel)}`,
          `isCodex: ${isOpenAICodexModel(ctx.model)}`,
          `latestSnapshot: ${latestSnapshot ? JSON.stringify(latestSnapshot) : "none"}`,
          `lastHeaders: ${lastHeaders.length ? lastHeaders.join(", ") : "none"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastStatus = "session started";
    installInlineFooter(ctx, () => pi.getThinkingLevel());
    updateStatus(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    lastStatus = `model selected: ${modelSummary(asModel(event.model))}`;
    updateStatus(ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    lastStatus = `provider request for ${modelSummary(asModel(ctx.model))}`;
    updateStatus(ctx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    const headers = (event.headers ?? {}) as HeadersRecord;
    lastHeaders = Object.keys(headers).filter((key) => key.toLowerCase().includes("codex"));

    if (!isOpenAICodexModel(ctx.model)) {
      lastStatus = `provider response ignored for non-Codex model: ${modelSummary(asModel(ctx.model))}`;
      updateStatus(ctx);
      return;
    }

    const snapshot = parseSnapshot(headers);
    if (!snapshot) {
      lastStatus = `Codex response seen, but no x-codex rate-limit headers exposed; codex headers: ${lastHeaders.join(", ") || "none"}`;
      updateStatus(ctx);
      return;
    }

    latestSnapshot = snapshot;
    lastStatus = "Codex rate-limit headers captured";
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    requestFooterRender = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setFooter(undefined);
  });
}
