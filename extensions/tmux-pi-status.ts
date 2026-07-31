import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Marks this Pi process's tmux pane without affecting any other pane. */
export default function (pi: ExtensionAPI) {
  const pane = process.env.TMUX_PANE;

  const setPaneOption = async (name: "@pi_status" | "@pi_indicator", value: string) => {
    if (!pane) return;
    try {
      await pi.exec("tmux", ["set-option", "-p", "-t", pane, name, value], { timeout: 1_000 });
    } catch {
      // Pi can also run outside tmux; status decoration must never affect it.
    }
  };

  const setPaneStatus = (status: "ready" | "working" | "off") => setPaneOption("@pi_status", status);
  // tmux style sequences are interpreted when the option is expanded in the
  // window-status format.  All frames occupy one terminal cell.
  const WORKING_FRAMES = [
    "#[fg=colour52]⏺ ", "#[fg=colour52]◉ ", "#[fg=colour88]● ",
    "#[fg=colour124]◉ ", "#[fg=red]⏺ ", "#[fg=red,bold]◉ ",
    "#[fg=red,bold]● ", "#[fg=red,bold]◉ ", "#[fg=red]⏺ ",
    "#[fg=colour124]◌ ", "#[fg=colour88]○ ", "#[fg=colour52]◌ ",
  ];
  const READY_INDICATOR = "#[fg=colour10]● ";
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;

  const stopAnimation = async (status: "ready" | "off") => {
    if (animationTimer) clearInterval(animationTimer);
    animationTimer = undefined;
    frame = 0;
    await Promise.all([
      setPaneStatus(status),
      setPaneOption("@pi_indicator", status === "ready" ? READY_INDICATOR : ""),
    ]);
  };

  const startAnimation = async () => {
    if (animationTimer) clearInterval(animationTimer);
    frame = 0;
    await setPaneStatus("working");
    const renderFrame = () => {
      void setPaneOption("@pi_indicator", WORKING_FRAMES[frame++ % WORKING_FRAMES.length]!);
    };
    renderFrame();
    animationTimer = setInterval(renderFrame, 140);
    animationTimer.unref?.();
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") await stopAnimation("ready");
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode === "tui") await startAnimation();
  });

  // agent_settled, unlike agent_end, waits through automatic retries,
  // compaction retries, and queued messages.
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode === "tui") await stopAnimation("ready");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") await stopAnimation("off");
  });
}
