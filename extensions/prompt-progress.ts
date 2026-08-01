import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Terminal colors are discrete, so this is a gentle ~1.7 s glow cycle rather
// than a literal alpha fade. Keep message and indicator animation in sync.
const GLOW_INTERVAL_MS = 140;
// Each reported token total is counted through in at most this long. Smaller
// gaps get a slower, more legible cadence; larger gaps redraw more frequently.
const MAX_TOKEN_COUNT_DURATION_MS = 10_000;
// Cost advances in whole cents and catches up more quickly than token output.
const MAX_COST_COUNT_DURATION_MS = 3_000;
const GLOW_COLORS = ["dim", "dim", "muted", "muted", "accent", "accent", "accent", "accent", "muted", "muted", "dim", "dim"] as const;
const WORKING_DOT_FRAMES = [".  ", ".. ", "...", ".. ", ".  ", "   "];
// One-cell glyphs only: this animates the leading indicator without changing
// the Working text, dot animation, elapsed time, or token counter beside it.
const WORKING_INDICATOR_FRAMES = ["⏺", "◉", "●", "◉", "⏺", "◌", "○", "◌", "⏺", "◉", "●", "◉"];

function glowText(ctx: ExtensionContext, text: string, frame: number): string {
  const color = GLOW_COLORS[frame % GLOW_COLORS.length]!;
  const styled = ctx.ui.theme.fg(color, text);
  // A brief bright peak makes the color ramp read as a glow in ANSI terminals.
  return color === "accent" && frame % GLOW_COLORS.length === 6 ? ctx.ui.theme.bold(styled) : styled;
}

function glowIndicator(ctx: ExtensionContext) {
  return {
    frames: GLOW_COLORS.map((color, frame) => {
      const styled = ctx.ui.theme.fg(color, WORKING_INDICATOR_FRAMES[frame]!);
      return color === "accent" && frame === 6 ? ctx.ui.theme.bold(styled) : styled;
    }),
    intervalMs: GLOW_INTERVAL_MS,
  };
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTokens(tokens: number): string {
  return Math.max(0, Math.floor(tokens)).toLocaleString("en-US");
}

function formatWorkedFor(elapsedMs: number, outputTokens: number, costCents: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const units = [
    hours > 0 ? `${hours}h` : undefined,
    minutes > 0 ? `${minutes}m` : undefined,
    seconds > 0 ? `${seconds}s` : undefined,
  ].filter((unit): unit is string => unit !== undefined);
  return `✻ Worked for ${units.join(" ") || "0s"} (${formatTokens(outputTokens)} tokens, $${(costCents / 100).toFixed(2)})`;
}

function costToCents(cost: number): number {
  // Match the footer's displayed-cost policy: fractional cents round upward.
  return Math.max(0, Math.ceil(cost * 100 - Number.EPSILON));
}

// Claude Opus 4 pricing per million tokens (fallback for local/free models)
const OPUS_COSTS = {
  input: 5,           // $5.00 per 1M input tokens
  output: 25,         // $25.00 per 1M output tokens
  cacheRead: 0.5,     // $0.50 per 1M cache read tokens
  cacheWrite: 6.25,   // $6.25 per 1M cache write tokens
};

/** Compute Opus-equivalent cost from token counts */
function computeOpusCost(input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return (
    (input / 1_000_000) * OPUS_COSTS.input +
    (output / 1_000_000) * OPUS_COSTS.output +
    (cacheRead / 1_000_000) * OPUS_COSTS.cacheRead +
    (cacheWrite / 1_000_000) * OPUS_COSTS.cacheWrite
  );
}

/**
 * Resolve the effective cost: if the provider reports $0 (local/free model)
 * but we have token counts, fall back to Opus-equivalent pricing.
 */
function resolveCost(rawCost: number, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  if (rawCost > 0) return rawCost;
  if (input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0) {
    return computeOpusCost(input, output, cacheRead, cacheWrite);
  }
  return 0;
}

export default function (pi: ExtensionAPI) {
  let activeContext: ExtensionContext | undefined;
  let promptStartedAt: number | undefined;
  let completedOutputTokens = 0;
  let streamingOutputTokens = 0;
  // Providers report output usage in occasional jumps. Keep a separate
  // displayed value so the working row can advance smoothly toward each jump.
  let targetOutputTokens = 0;
  let displayedOutputTokens = 0;
  // Cost is scoped to the active prompt, including any intermediate assistant
  // responses/tool-call turns it produces—not the full session total.
  let completedCost = 0;
  let streamingCost = 0;
  let targetCostCents = 0;
  let displayedCostCents = 0;
  let promptGeneration = 0;
  let streamingGeneration = 0;
  let workingAnimationFrame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tokenCounterTimer: ReturnType<typeof setInterval> | undefined;
  let costCounterTimer: ReturnType<typeof setInterval> | undefined;

  const advanceTokenCounter = () => {
    if (displayedOutputTokens >= targetOutputTokens) return false;
    displayedOutputTokens += 1;
    return true;
  };

  const restartTokenCounter = () => {
    if (tokenCounterTimer) clearInterval(tokenCounterTimer);
    tokenCounterTimer = undefined;

    const remaining = targetOutputTokens - displayedOutputTokens;
    if (!activeContext || remaining <= 0) return;

    // One increment per tick, with enough ticks to reach this target within
    // ten seconds. Clamp to Node's practical minimum timer resolution.
    const intervalMs = Math.max(1, Math.floor(MAX_TOKEN_COUNT_DURATION_MS / remaining));
    tokenCounterTimer = setInterval(() => {
      update(false, true);
      if (displayedOutputTokens >= targetOutputTokens && tokenCounterTimer) {
        clearInterval(tokenCounterTimer);
        tokenCounterTimer = undefined;
      }
    }, intervalMs);
  };

  const setTokenTarget = (nextTarget: number) => {
    // Provider usage reports are cumulative and may arrive in large jumps.
    // Keep the highest known value and recalculate the cadence from the
    // current displayed value whenever the target increases.
    if (nextTarget <= targetOutputTokens) return;
    targetOutputTokens = nextTarget;
    restartTokenCounter();
  };

  const advanceCostCounter = () => {
    if (displayedCostCents >= targetCostCents) return false;
    displayedCostCents += 1;
    return true;
  };

  const restartCostCounter = () => {
    if (costCounterTimer) clearInterval(costCounterTimer);
    costCounterTimer = undefined;

    const remaining = targetCostCents - displayedCostCents;
    if (!activeContext || remaining <= 0) return;

    const intervalMs = Math.max(1, Math.floor(MAX_COST_COUNT_DURATION_MS / remaining));
    costCounterTimer = setInterval(() => {
      update(false, false, true);
      if (displayedCostCents >= targetCostCents && costCounterTimer) {
        clearInterval(costCounterTimer);
        costCounterTimer = undefined;
      }
    }, intervalMs);
  };

  const setCostTarget = (cost: number) => {
    const nextTarget = costToCents(cost);
    if (nextTarget <= targetCostCents) return;
    targetCostCents = nextTarget;
    restartCostCounter();
  };

  const update = (advanceWorkingFrame = true, advanceTokens = false, advanceCost = false) => {
    if (!activeContext || promptStartedAt === undefined) return;
    if (advanceTokens) advanceTokenCounter();
    if (advanceCost) advanceCostCounter();

    const elapsed = formatElapsed(Date.now() - promptStartedAt);
    const outputTokens = displayedOutputTokens;
    const frame = workingAnimationFrame;
    const dots = WORKING_DOT_FRAMES[frame % WORKING_DOT_FRAMES.length] ?? "   ";
    if (advanceWorkingFrame) workingAnimationFrame = (workingAnimationFrame + 1) % GLOW_COLORS.length;
    const working = glowText(activeContext, "Working", frame);
    const animatedDots = glowText(activeContext, dots, frame);
    activeContext.ui.setWorkingMessage(
      `${working}${animatedDots} (${elapsed} · ↓ ${formatTokens(outputTokens)} tokens · $${(displayedCostCents / 100).toFixed(2)})`,
    );
  };

  const start = (ctx: ExtensionContext) => {
    activeContext = ctx;
    if (promptStartedAt === undefined) {
      promptStartedAt = Date.now();
      completedOutputTokens = 0;
      streamingOutputTokens = 0;
      targetOutputTokens = 0;
      displayedOutputTokens = 0;
      completedCost = 0;
      streamingCost = 0;
      targetCostCents = 0;
      displayedCostCents = 0;
      workingAnimationFrame = 0;
      promptGeneration++;
    }
    ctx.ui.setWorkingIndicator(glowIndicator(ctx));
    update();
    if (!timer) timer = setInterval(() => update(true), GLOW_INTERVAL_MS);
    restartTokenCounter();
    restartCostCounter();
  };

  const stop = (ctx: ExtensionContext) => {
    if (timer) clearInterval(timer);
    if (tokenCounterTimer) clearInterval(tokenCounterTimer);
    if (costCounterTimer) clearInterval(costCounterTimer);
    timer = undefined;
    tokenCounterTimer = undefined;
    costCounterTimer = undefined;
    activeContext = undefined;
    promptStartedAt = undefined;
    streamingOutputTokens = 0;
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
  };

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    promptStartedAt = Date.now();
    completedOutputTokens = 0;
    streamingOutputTokens = 0;
    targetOutputTokens = 0;
    displayedOutputTokens = 0;
    completedCost = 0;
    streamingCost = 0;
    targetCostCents = 0;
    displayedCostCents = 0;
    if (tokenCounterTimer) clearInterval(tokenCounterTimer);
    if (costCounterTimer) clearInterval(costCounterTimer);
    tokenCounterTimer = undefined;
    costCounterTimer = undefined;
    workingAnimationFrame = 0;
    promptGeneration++;
    update();
  });

  pi.on("agent_start", (_event, ctx) => start(ctx));

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    streamingGeneration = promptGeneration;
    streamingOutputTokens = 0;
    streamingCost = 0;
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant" || streamingGeneration !== promptGeneration) return;

    const partialUsage = event.assistantMessageEvent.partial.usage;
    const msgUsage = event.message.usage;

    // Read the partial message carried by this exact provider stream event,
    // rather than waiting for a completed assistant message. This renders each
    // output-token value the provider exposes as soon as Pi receives it.
    const output = partialUsage?.output ?? msgUsage?.output;
    if (typeof output === "number" && Number.isFinite(output)) {
      // The fixed animation timer advances the displayed count toward this
      // target; do not tick per token, which would make it model-dependent.
      streamingOutputTokens = output;
      setTokenTarget(completedOutputTokens + streamingOutputTokens);
    }

    // Resolve cost: use provider-reported cost, but fall back to Opus-equivalent
    // pricing for local/free models where the provider returns $0.
    const rawCost = partialUsage?.cost?.total ?? msgUsage?.cost?.total;
    const input = partialUsage?.input ?? 0;
    const cacheRead = partialUsage?.cacheRead ?? 0;
    const cacheWrite = partialUsage?.cacheWrite ?? 0;
    if (typeof rawCost === "number" && Number.isFinite(rawCost)) {
      streamingCost = resolveCost(rawCost, input, output, cacheRead, cacheWrite);
      setCostTarget(completedCost + streamingCost);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || streamingGeneration !== promptGeneration) return;

    const msgUsage = event.message.usage;

    // A final usage value can arrive before the counter has had a chance to
    // render even one increment. Treat it as another target, not an immediate
    // display value; assigning displayedOutputTokens here was the source of
    // the visible jumps.
    const output = msgUsage?.output;
    const finalOutput = typeof output === "number" && Number.isFinite(output) ? output : streamingOutputTokens;
    completedOutputTokens += finalOutput;
    streamingOutputTokens = 0;
    setTokenTarget(completedOutputTokens);

    // Resolve cost: use provider-reported cost, but fall back to Opus-equivalent
    // pricing for local/free models where the provider returns $0.
    const rawCost = msgUsage?.cost?.total;
    const input = msgUsage?.input ?? 0;
    const cacheRead = msgUsage?.cacheRead ?? 0;
    const cacheWrite = msgUsage?.cacheWrite ?? 0;
    const finalCost = typeof rawCost === "number" && Number.isFinite(rawCost)
      ? resolveCost(rawCost, input, output, cacheRead, cacheWrite)
      : streamingCost;
    completedCost += finalCost;
    streamingCost = 0;
    setCostTarget(completedCost);

    // Tool-call messages are intermediate work. Add the summary only to the
    // final response, after any queued user prompt has also completed.
    if (event.message.content.some((part) => part.type === "toolCall") || ctx.hasPendingMessages()) return;
    if (event.message.stopReason === "error" || promptStartedAt === undefined) return;
    if (event.message.content.some(
      (part) => part.type === "text" && /(?:^|\n)✻ Worked for /.test(part.text),
    )) return;

    const footer = formatWorkedFor(
      Date.now() - promptStartedAt,
      completedOutputTokens,
      costToCents(completedCost),
    );
    const content = [...event.message.content];
    const lastTextIndex = content.map((part) => part.type).lastIndexOf("text");

    if (lastTextIndex >= 0) {
      const lastText = content[lastTextIndex];
      if (lastText?.type === "text") {
        content[lastTextIndex] = { ...lastText, text: `${lastText.text.trimEnd()}\n\n${footer}` };
      }
    } else {
      content.push({ type: "text", text: footer });
    }

    return { message: { ...event.message, content } };
  });

  pi.on("agent_settled", (_event, ctx) => stop(ctx));
  pi.on("session_shutdown", (_event, ctx) => stop(ctx));
}
