import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type GpuNode = {
  name: string;
  state: string;
  gpuType: string;
  total: number;
  allocated: number;
  unhealthy: boolean;
  restricted: boolean;
  reason?: string;
};

const BAD_STATE = /(?:DOWN|DRAIN|FAIL|NOT_RESPONDING|NO_RESPOND|MAINT|INVAL)/;
const RESTRICTED_STATE = /(?:RESERVED|PLANNED)/;

function field(line: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line)?.[1];
}

function parseNodes(output: string): GpuNode[] {
  return output.split("\n").flatMap((line) => {
    const name = field(line, "NodeName");
    const gres = field(line, "Gres");
    const state = field(line, "State");
    if (!name || !gres || !state) return [];

    // Slurm reports both physical GPUs (gpu:h200:8) and MIG instances
    // (gpu:h200_1g.18gb:56) as generic GPU GRES resources.
    const gresMatch = /^gpu:(.+):(\d+)$/.exec(gres) ?? /^gpu:(\d+)$/.exec(gres);
    if (!gresMatch) return [];
    const total = Number(gresMatch[2] ?? gresMatch[1]);
    const gpuType = gresMatch[2] ? gresMatch[1]! : "gpu";
    if (!Number.isFinite(total) || total < 1) return [];

    const allocTRES = /(?:^|\s)AllocTRES=(.*?)(?=\s(?:CurrentWatts|AveWatts|Reason|$)|$)/.exec(line)?.[1] ?? "";
    const allocated = Number(/(?:^|,)gres\/gpu=(\d+)/.exec(allocTRES)?.[1] ?? 0);
    const reason = /(?:^|\s)Reason=(.*)$/.exec(line)?.[1];

    return [{
      name,
      state,
      gpuType,
      total,
      allocated: Math.min(total, Math.max(0, allocated)),
      unhealthy: BAD_STATE.test(state),
      restricted: RESTRICTED_STATE.test(state),
      reason,
    }];
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function getGpuNodes(pi: ExtensionAPI, signal?: AbortSignal): Promise<GpuNode[]> {
  const result = await pi.exec("scontrol", ["show", "node", "-o"], { signal, timeout: 10_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "scontrol show node failed");
  const nodes = parseNodes(result.stdout);
  if (nodes.length === 0) throw new Error("Slurm returned no GPU nodes");
  return nodes;
}

class HealthPanel {
  private nodes: GpuNode[];
  private refreshedAt = new Date();
  private refreshing = false;
  private disposed = false;
  private refreshError?: string;
  private readonly refreshController = new AbortController();
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(
    nodes: GpuNode[],
    private readonly theme: Theme,
    private readonly close: () => void,
    private readonly load: (signal: AbortSignal) => Promise<GpuNode[]>,
    private readonly requestRender: () => void,
  ) {
    this.nodes = nodes;
    this.refreshTimer = setInterval(() => void this.refresh(), 5_000);
    this.refreshTimer.unref?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") this.close();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.disposed) return;
    this.refreshing = true;
    try {
      this.nodes = await this.load(this.refreshController.signal);
      this.refreshedAt = new Date();
      this.refreshError = undefined;
    } catch (error) {
      if (!this.refreshController.signal.aborted) {
        this.refreshError = error instanceof Error ? error.message : "Slurm refresh failed";
      }
    } finally {
      this.refreshing = false;
      if (!this.disposed) this.requestRender();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const allocatable = this.nodes.filter((node) => !node.unhealthy && !node.restricted);
    const total = this.nodes.reduce((sum, node) => sum + node.total, 0);
    const allocated = this.nodes.reduce((sum, node) => sum + node.allocated, 0);
    const free = allocatable.reduce((sum, node) => sum + node.total - node.allocated, 0);
    const bad = this.nodes.filter((node) => node.unhealthy).length;
    const inner = Math.max(1, width - 2);
    const border = (text: string) => th.fg("borderAccent", text);
    const pad = (text: string, target = inner) => text + " ".repeat(Math.max(0, target - visibleWidth(text)));
    const row = (text = "") => border("│") + pad(truncateToWidth(text, inner)) + border("│");
    const lines = [border(`╭${"─".repeat(inner)}╮`)];

    lines.push(row(` ${th.fg("accent", th.bold("Slurm GPU health"))}  ${th.fg("dim", `${this.nodes.length} nodes · ${total} GPU resources · updated ${this.refreshedAt.toLocaleTimeString()}`)}`));
    lines.push(row(` ${th.fg("success", `${allocated} allocated`)} · ${th.fg("success", `${free} free on allocatable nodes`)}${bad ? ` · ${th.fg("error", `${bad} unhealthy`)}` : ""}${this.refreshing ? ` · ${th.fg("dim", "refreshing")}` : ""}`));
    lines.push(row(` ${th.fg("success", "○ GPU-free  ◐ GPU-partial  ● GPU-full")}  ${th.fg("warning", "R reserved  P planned")}  ${th.fg("error", "× unavailable")}`));
    if (this.refreshError) lines.push(row(th.fg("error", ` Refresh error: ${this.refreshError}`)));
    lines.push(row());

    const columns = 3;
    const separator = ` ${th.fg("borderMuted", "│")} `;
    const cardWidth = Math.max(1, Math.floor((inner - (columns - 1) * 3) / columns));
    for (let index = 0; index < this.nodes.length; index += columns) {
      const cards = Array.from({ length: columns }, (_, offset) => {
        const node = this.nodes[index + offset];
        return node ? this.cardLines(node, cardWidth) : [""];
      });
      const height = Math.max(...cards.map((card) => card.length));
      for (let line = 0; line < height; line++) {
        lines.push(row(cards.map((card) => pad(card[line] ?? "", cardWidth)).join(separator)));
      }
    }

    lines.push(row());
    lines.push(row(th.fg("dim", " Refreshes every 5 seconds · Esc/Enter/q close")));
    lines.push(border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private cardLines(node: GpuNode, width: number): string[] {
    const th = this.theme;
    const state = this.stateSymbol(node);
    const color = node.unhealthy ? "error" : node.restricted ? "warning" : "success";
    const glyphs = `${"●".repeat(node.allocated)}${"○".repeat(node.total - node.allocated)}`;
    const chunks = glyphs.match(/.{1,8}/g) ?? [""];
    return chunks.map((chunk, index) => {
      const prefix = index === 0
        ? `${th.fg("accent", node.name)} ${th.fg(color, state)} `
        : "       ";
      return truncateToWidth(prefix + th.fg(color, chunk), width);
    });
  }

  private stateSymbol(node: GpuNode): string {
    if (node.unhealthy) return "×";
    if (node.state.includes("RESERVED")) return "R";
    if (node.state.includes("PLANNED")) return "P";

    // Slurm's node state includes CPU and memory allocation, so MIXED does
    // not necessarily mean that a GPU is free.  Derive this indicator from
    // GPU allocation itself: full, partial, then idle.
    if (node.allocated >= node.total) return "●";
    if (node.allocated > 0) return "◐";
    if (node.state.includes("IDLE")) return "○";
    return "?";
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    this.refreshController.abort();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sinfo", {
    description: "Show Slurm GPU allocation and node health",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/sinfo requires interactive TUI mode", "error");
        return;
      }

      const nodes = await ctx.ui.custom<GpuNode[] | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Reading Slurm GPU health...");
        loader.onAbort = () => done(null);
        getGpuNodes(pi, loader.signal).then(done).catch((error: unknown) => {
          ctx.ui.notify(error instanceof Error ? error.message : "Could not read Slurm health", "error");
          done(null);
        });
        return loader;
      });
      if (!nodes) return;

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => new HealthPanel(
          nodes,
          theme,
          () => done(),
          (signal) => getGpuNodes(pi, signal),
          () => tui.requestRender(),
        ),
        { overlay: true, overlayOptions: { width: "90%", minWidth: 68, maxWidth: 120, maxHeight: "90%" } },
      );
    },
  });
}
