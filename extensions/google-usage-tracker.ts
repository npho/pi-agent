import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "google-usage";

interface UsageRecord {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function isGoogleModel(model: unknown, provider?: string): boolean {
  if (provider && provider.toLowerCase().includes("google")) return true;
  if (!model) return false;
  if (typeof model === "string") {
    const l = model.toLowerCase();
    return l.includes("google") || l.includes("gemini") || l.includes("gemma");
  }
  if (typeof model === "object") {
    const m = model as any;
    const p = String(m.provider ?? "").toLowerCase();
    const id = String(m.id ?? m.name ?? "").toLowerCase();
    const api = String(m.api ?? "").toLowerCase();
    return (
      p.includes("google") ||
      id.includes("gemini") ||
      id.includes("gemma") ||
      api.includes("google")
    );
  }
  return false;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export default function googleUsageTracker(pi: ExtensionAPI) {
  let requestLog: UsageRecord[] = [];
  let refreshTimer: NodeJS.Timeout | undefined;

  function loadFromSession(ctx: ExtensionContext) {
    requestLog = [];
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const msg = entry.message as any;
        if (isGoogleModel(msg.model, msg.provider)) {
          const usage = msg.usage;
          if (usage) {
            const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : msg.timestamp || Date.now();
            const input = Number(usage.input ?? 0);
            const output = Number(usage.output ?? 0);
            const total = Number(usage.totalTokens ?? (input + output));
            requestLog.push({
              timestamp: ts,
              model: String(msg.model || "google"),
              inputTokens: input,
              outputTokens: output,
              totalTokens: total,
            });
          }
        }
      }
    }
  }

  function updateDisplay(ctx: ExtensionContext) {
    if (!isGoogleModel(ctx.model)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const now = Date.now();
    const oneMinAgo = now - 60_000;
    const twentyFourHoursAgo = now - 86_400_000;

    const log1m = requestLog.filter((r) => r.timestamp >= oneMinAgo);
    const log24h = requestLog.filter((r) => r.timestamp >= twentyFourHoursAgo);

    const rpm = log1m.length;
    const tpm = log1m.reduce((acc, r) => acc + r.totalTokens, 0);

    const reqs24h = log24h.length;
    const tokens24h = log24h.reduce((acc, r) => acc + r.totalTokens, 0);

    const reqsSession = requestLog.length;
    const tokensSession = requestLog.reduce((acc, r) => acc + r.totalTokens, 0);

    const theme = ctx.ui.theme;
    const prefix = theme ? theme.fg("accent", "⚡ Google AI:") : "⚡ Google AI:";
    const minStat = theme
      ? theme.fg("warning", `1m: ${rpm} req (${formatTokens(tpm)} tpm)`)
      : `1m: ${rpm} req (${formatTokens(tpm)} tpm)`;
    const sessionStat = theme
      ? theme.fg("dim", `Session: ${reqsSession} req (${formatTokens(tokensSession)} tok)`)
      : `Session: ${reqsSession} req (${formatTokens(tokensSession)} tok)`;

    const statusText = `${prefix} ${minStat} | ${sessionStat}`;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }

  pi.registerCommand("google-usage", {
    description: "Display Google AI Studio API usage statistics",
    handler: async (_args, ctx) => {
      const now = Date.now();
      const log1m = requestLog.filter((r) => r.timestamp >= now - 60_000);
      const log24h = requestLog.filter((r) => r.timestamp >= now - 86_400_000);

      const rpm = log1m.length;
      const tpm = log1m.reduce((acc, r) => acc + r.totalTokens, 0);

      const reqs24h = log24h.length;
      const tokens24h = log24h.reduce((acc, r) => acc + r.totalTokens, 0);

      const reqsSession = requestLog.length;
      const tokensSession = requestLog.reduce((acc, r) => acc + r.totalTokens, 0);

      const isActive = isGoogleModel(ctx.model);

      const msg = [
        "📊 Google AI Studio Usage Statistics (Local Tracking)",
        `Active Model: ${(ctx.model as any)?.id || "None"} (Google Model Active: ${isActive})`,
        "----------------------------------------",
        `• Last 1 Minute:  ${rpm} requests, ${formatTokens(tpm)} tokens (${tpm} total)`,
        `• Current Session: ${reqsSession} requests, ${formatTokens(tokensSession)} tokens`,
        `• Last 24 Hours:   ${reqs24h} requests, ${formatTokens(tokens24h)} tokens`,
        "----------------------------------------",
        "Note: Tracked locally across Google AI Studio requests in Pi.",
      ].join("\n");

      ctx.ui.notify(msg, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    loadFromSession(ctx);
    updateDisplay(ctx);

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      updateDisplay(ctx);
    }, 5000);
  });

  pi.on("model_select", (_event, ctx) => {
    updateDisplay(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const msg = event.message as any;
    if (isGoogleModel(msg.model, msg.provider) || isGoogleModel(ctx.model)) {
      const usage = msg.usage;
      if (usage) {
        const input = Number(usage.input ?? 0);
        const output = Number(usage.output ?? 0);
        const total = Number(usage.totalTokens ?? (input + output));
        requestLog.push({
          timestamp: msg.timestamp || Date.now(),
          model: String(msg.model || (ctx.model as any)?.id || "google"),
          inputTokens: input,
          outputTokens: output,
          totalTokens: total,
        });
        updateDisplay(ctx);
      }
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
