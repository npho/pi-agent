/**
 * ctx-guard: context-zone warning for models with a "native" context range
 * that is smaller than the configured contextWindow.
 *
 * For vllm/Qwen3.8-27B-FP8 the native trained range is 262144 tokens; the
 * server accepts up to ~1M via rope extrapolation. This extension:
 *   - shows a footer status marker once context exceeds the native range
 *   - shows a stronger marker past the caution line
 *   - fires a one-shot notification on each upward threshold crossing
 *
 * Add entries to THRESHOLDS for other models (tokens).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Zone {
  /** Enter this zone above `native` tokens. */
  native: number;
  /** Stronger warning above `caution` tokens. */
  caution: number;
}

const THRESHOLDS: Record<string, Zone> = {
  "vllm/Qwen3.8-27B-FP8": { native: 262_144, caution: 700_000 },
};

const STATUS_KEY = "ctx-guard";

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`;
}

export default function (pi: ExtensionAPI) {
  let warnedNative = false;
  let warnedCaution = false;

  function modelKey(ctx: ExtensionContext): string | undefined {
    return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  }

  function resetWarnings() {
    warnedNative = false;
    warnedCaution = false;
  }

  function refresh(ctx: ExtensionContext) {
    const zone = THRESHOLDS[modelKey(ctx) ?? ""];
    if (!zone) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null) return;
    const t = usage.tokens;

    if (t > zone.caution) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `⚠⚠ ctx ${fmt(t)} — deep extrapolation (native ${fmt(zone.native)}): verify outputs carefully`,
      );
      if (!warnedCaution) {
        warnedCaution = true;
        ctx.ui.notify(
          `ctx-guard: context ${fmt(t)} is far beyond the model's native ${fmt(zone.native)} range. Long-context accuracy is degraded — double-check important outputs.`,
          "warning",
        );
      }
    } else if (t > zone.native) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `⚠ ctx ${fmt(t)} > native ${fmt(zone.native)} — extrapolated range, watch accuracy`,
      );
      if (!warnedNative) {
        warnedNative = true;
        ctx.ui.notify(
          `ctx-guard: context ${fmt(t)} crossed the native ${fmt(zone.native)} limit. The model is now operating on rope-extrapolated positions — point lookups hold up, but cross-context reasoning may degrade.`,
          "warning",
        );
      }
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      // Back in the safe zone: allow the warnings to fire again on re-crossing.
      if (warnedCaution && t <= zone.native) resetWarnings();
    }
  }

  pi.on("turn_end", (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    resetWarnings();
    refresh(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    resetWarnings();
    refresh(ctx);
  });
}
