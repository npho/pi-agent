import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Terminal colors are discrete, so this is a gentle ~1.7 s glow cycle rather
// than a literal alpha fade. Keep message and indicator animation in sync.
const GLOW_INTERVAL_MS = 140;
// Each reported token total is counted through in at most this long. Smaller
// gaps get a slower, more legible cadence; larger gaps redraw more frequently.
const MAX_TOKEN_COUNT_DURATION_MS = 10_000;
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

export default function (pi: ExtensionAPI) {
  let activeContext: ExtensionContext | undefined;
  let promptStartedAt: number | undefined;
  let completedOutputTokens = 0;
  let streamingOutputTokens = 0;
  // Providers report output usage in occasional jumps. Keep a separate
  // displayed value so the working row can advance smoothly toward each jump.
  let targetOutputTokens = 0;
  let displayedOutputTokens = 0;
  let promptGeneration = 0;
  let streamingGeneration = 0;
  let workingAnimationFrame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tokenCounterTimer: ReturnType<typeof setInterval> | undefined;

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

  const update = (advanceWorkingFrame = true, advanceCounter = false) => {
    if (!activeContext || promptStartedAt === undefined) return;
    if (advanceCounter) advanceTokenCounter();

    const elapsed = formatElapsed(Date.now() - promptStartedAt);
    const outputTokens = displayedOutputTokens;
    const frame = workingAnimationFrame;
    const dots = WORKING_DOT_FRAMES[frame % WORKING_DOT_FRAMES.length] ?? "   ";
    if (advanceWorkingFrame) workingAnimationFrame = (workingAnimationFrame + 1) % GLOW_COLORS.length;
    const working = glowText(activeContext, "Working", frame);
    const animatedDots = glowText(activeContext, dots, frame);
    activeContext.ui.setWorkingMessage(
      `${working}${animatedDots} (${elapsed} · ↓ ${formatTokens(outputTokens)} tokens)`,
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
      workingAnimationFrame = 0;
      promptGeneration++;
    }
    ctx.ui.setWorkingIndicator(glowIndicator(ctx));
    update();
    if (!timer) timer = setInterval(() => update(true), GLOW_INTERVAL_MS);
    restartTokenCounter();
  };

  const stop = (ctx: ExtensionContext) => {
    if (timer) clearInterval(timer);
    if (tokenCounterTimer) clearInterval(tokenCounterTimer);
    timer = undefined;
    tokenCounterTimer = undefined;
    activeContext = undefined;
    promptStartedAt = undefined;
    streamingOutputTokens = 0;
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
  };

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    promptStartedAt = Date.now();
    completedOutputTokens = 0;
    streamingOutputTokens = 0;
    targetOutputTokens = 0;
    displayedOutputTokens = 0;
    if (tokenCounterTimer) clearInterval(tokenCounterTimer);
    tokenCounterTimer = undefined;
    workingAnimationFrame = 0;
    promptGeneration++;
    update();
  });

  pi.on("agent_start", (_event, ctx) => start(ctx));

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    streamingGeneration = promptGeneration;
    streamingOutputTokens = 0;
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant" || streamingGeneration !== promptGeneration) return;

    // Read the partial message carried by this exact provider stream event,
    // rather than waiting for a completed assistant message. This renders each
    // output-token value the provider exposes as soon as Pi receives it.
    const output = event.assistantMessageEvent.partial.usage?.output ?? event.message.usage?.output;
    if (typeof output === "number" && Number.isFinite(output)) {
      // The fixed animation timer advances the displayed count toward this
      // target; do not tick per token, which would make it model-dependent.
      streamingOutputTokens = output;
      setTokenTarget(completedOutputTokens + streamingOutputTokens);
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || streamingGeneration !== promptGeneration) return;

    // A final usage value can arrive before the counter has had a chance to
    // render even one increment. Treat it as another target, not an immediate
    // display value; assigning displayedOutputTokens here was the source of
    // the visible jumps.
    const output = event.message.usage?.output;
    const finalOutput = typeof output === "number" && Number.isFinite(output) ? output : streamingOutputTokens;
    completedOutputTokens += finalOutput;
    streamingOutputTokens = 0;
    setTokenTarget(completedOutputTokens);
  });

  pi.on("agent_settled", (_event, ctx) => stop(ctx));
  pi.on("session_shutdown", (_event, ctx) => stop(ctx));
}
