import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CELL = "███";
const FRAME_MS = 120;
// tmux's `colour208` (#ff8700)
const TMUX_ORANGE = "\x1b[38;5;208m";
const RESET_FG = "\x1b[39m";

type Cell = "empty" | "cyan" | "red" | "green" | "orange" | "white" | "accent";
type Frame = { phase: number; active: "left" | "top" | "right" | "none"; x: number; y: number; flash?: boolean; white?: boolean };

const FRAMES: Frame[] = [
  ...Array.from({ length: 4 }, (_, y) => ({ phase: 0, active: "left" as const, x: 2, y })),
  ...Array.from({ length: 3 }, (_, y) => ({ phase: 1, active: "top" as const, x: 2, y })),
  ...Array.from({ length: 5 }, (_, y) => ({ phase: 2, active: "right" as const, x: 5, y })),
  { phase: 3, active: "none", x: 0, y: 0 },
  { phase: 3, active: "none", x: 0, y: 0, flash: true },
  { phase: 3, active: "none", x: 0, y: 0 },
  { phase: 3, active: "none", x: 0, y: 0, flash: true },
  { phase: 4, active: "none", x: 0, y: 0 },
  { phase: 5, active: "none", x: 0, y: 0 },
  { phase: 5, active: "none", x: 0, y: 0, white: true },
  { phase: 5, active: "none", x: 0, y: 0 },
  { phase: 5, active: "none", x: 0, y: 0, white: true },
  { phase: 6, active: "none", x: 0, y: 0 },
];

const cells = (positions: string, y: number, x: number) => positions.split(" ").includes(`${y},${x}`);
const piece = (positions: string, y: number, x: number, originY: number, originX: number) =>
  positions.split(" ").some((position) => {
    const [dy, dx] = position.split(",").map(Number);
    return y === originY + dy && x === originX + dx;
  });

function cellAt(frame: Frame, y: number, x: number): Cell {
  const final = "3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5";
  if (frame.white) return cells(final, y, x) ? "white" : "empty";
  if (frame.flash && y === 6 && x >= 1 && x <= 6) return "orange";

  if (frame.active === "left" && piece("0,0 1,0 1,1 2,0", y, x, frame.y, frame.x)) return "red";
  if (frame.active === "top" && piece("0,0 0,1 0,2 1,2", y, x, frame.y, frame.x)) return "cyan";
  if (frame.active === "right" && piece("0,0 1,0 2,0 2,1", y, x, frame.y, frame.x)) return "green";

  if (frame.phase === 6) return cells(final, y, x) ? "accent" : "empty";
  if (frame.phase === 4) {
    if (cells("2,2 2,3 2,4 3,4", y, x)) return "cyan";
    if (cells("3,2 4,2 4,3 5,2", y, x)) return "red";
    if (cells("4,5 5,5", y, x)) return "green";
    return "empty";
  }
  if (frame.phase >= 5) {
    if (cells("3,2 3,3 3,4 4,4", y, x)) return "cyan";
    if (cells("4,2 5,2 5,3 6,2", y, x)) return "red";
    if (cells("5,5 6,5", y, x)) return "green";
    return "empty";
  }
  if (frame.phase <= 3 && cells("6,1 6,2 6,3 6,4", y, x)) return "orange";
  if (frame.phase >= 2 && cells("2,2 2,3 2,4 3,4", y, x)) return "cyan";
  if (frame.phase >= 1 && cells("3,2 4,2 4,3 5,2", y, x)) return "red";
  if (frame.phase >= 3 && cells("4,5 5,5 6,5 6,6", y, x)) return "green";
  return "empty";
}

function logo(frameIndex: number, accent: (text: string) => string): string[] {
  const frame = FRAMES[frameIndex % FRAMES.length]!;
  const color = (cell: Cell) => {
    switch (cell) {
      case "cyan": return `${TMUX_ORANGE}${CELL}${RESET_FG}`;
      case "red": return `\x1b[31m${CELL}${RESET_FG}`;
      case "green": return `\x1b[32m${CELL}${RESET_FG}`;
      case "orange": return `${TMUX_ORANGE}${CELL}${RESET_FG}`;
      case "white": return `${RESET_FG}${CELL}`;
      case "accent": return accent(CELL);
      default: return " ".repeat(CELL.length);
    }
  };

  const grid = Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 8 }, (_, column) => cellAt(frame, row + 1, column + 1)),
  );
  let min = 7;
  let max = 0;
  grid.forEach((row) => row.forEach((cell, x) => {
    if (cell !== "empty") { min = Math.min(min, x); max = Math.max(max, x); }
  }));
  if (max < min) { min = 0; max = 7; }
  return grid.map((row) => row.slice(min, max + 1).map(color).join(""));
}

const pad = (text: string, width: number, ellipsis = "") => {
  const clipped = truncateToWidth(text, width, ellipsis);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
const center = (text: string, width: number) => {
  if (visibleWidth(text) >= width) return truncateToWidth(text, width, "…");
  return " ".repeat(Math.floor((width - visibleWidth(text)) / 2)) + text;
};

class StartupHeader implements Component {
  private frame = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly pi: ExtensionAPI, private readonly ctx: ExtensionContext, private readonly tui: TUI) {
    this.timer = setInterval(() => {
      if (this.frame >= FRAMES.length - 1) return clearInterval(this.timer);
      this.frame++;
      this.tui.requestRender();
    }, FRAME_MS);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const accent = (text: string) => `${TMUX_ORANGE}${text}${RESET_FG}`;
    if (width < 24) return [accent(`Pi v${VERSION}`)];

    const inner = width - 2;
    const showTips = inner >= 47;
    const tipWidth = showTips ? Math.min(28, Math.max(16, Math.round(inner * 0.28))) : 0;
    const logoWidth = showTips ? inner - tipWidth - 3 : inner;
    const model = this.ctx.model?.id
      ? `${this.ctx.model.provider ? `${this.ctx.model.provider}/` : ""}${this.ctx.model.id}`
      : "Default model";
    const home = process.env.HOME;
    const cwd = home && this.ctx.cwd.startsWith(home) ? `~${this.ctx.cwd.slice(home.length)}` : this.ctx.cwd;
    const left = [
      ...logo(this.frame, accent).map((line) => center(line, logoWidth)),
      center(theme.bold("Let's build something great"), logoWidth),
      center(theme.fg("muted", `${model} · ${this.pi.getThinkingLevel()} effort`), logoWidth),
      center(theme.fg("dim", cwd), logoWidth),
    ];
    const tips = ["", accent(theme.bold("Getting started")), theme.fg("muted", "Ask Pi to build it"), accent("─".repeat(Math.min(tipWidth, 22))), accent(theme.bold("Commands")), theme.fg("muted", "/model"), theme.fg("muted", "/settings"), theme.fg("muted", "/new"), theme.fg("muted", "/resume"), ""];
    const border = (leftEdge: string, label: string, rightEdge: string) => {
      const prefix = label ? `─── ${label} ─────` : "";
      return `${accent(leftEdge)}${accent(prefix)}${accent("─".repeat(Math.max(0, width - 2 - visibleWidth(prefix))))}${accent(rightEdge)}`;
    };
    const lines = [border("╭", `Pi v${VERSION}`, "╮")];
    for (let i = 0; i < left.length; i++) {
      const content = showTips ? `${pad(left[i] ?? "", logoWidth)} ${accent("│")} ${pad(tips[i] ?? "", tipWidth, "…")}` : pad(left[i] ?? "", logoWidth);
      lines.push(`${accent("│")}${pad(content, inner)}${accent("│")}`);
    }
    lines.push(border("╰", "", "╯"));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
  dispose(): void { clearInterval(this.timer); }
}

let activeHeader: StartupHeader | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((tui) => {
      activeHeader?.dispose();
      activeHeader = new StartupHeader(pi, ctx, tui);
      return activeHeader;
    });
  });

  pi.on("session_shutdown", () => {
    activeHeader?.dispose();
    activeHeader = undefined;
  });
}
