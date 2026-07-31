import {
  getMarkdownTheme,
  type ExtensionAPI,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";

type Theme = {
  name?: string;
  bg(color: "userMessageBg", text: string): string;
  fg(color: "accent" | "warning" | "userMessageText", text: string): string;
};

type UserMessageComponentInternals = {
  text: string;
  outputPad: number;
  clear(): void;
  addChild(component: unknown): void;
  rebuild(): void;
};

let activeTheme: Theme | undefined;
let patched = false;

function promptMarker(): "accent" | "warning" {
  // In system-light, use the theme's warm warning color rather than its teal
  // accent so the prompt marker matches the theme's orange highlights.
  return activeTheme?.name === "system-light" ? "warning" : "accent";
}

function patchUserMessageRenderer(): void {
  if (patched) return;
  patched = true;

  const prototype = UserMessageComponent.prototype as unknown as UserMessageComponentInternals;
  const defaultRebuild = prototype.rebuild;

  prototype.rebuild = function (this: UserMessageComponentInternals): void {
    // Fall back to Pi's renderer until a TUI theme is available.
    if (!activeTheme) return defaultRebuild.call(this);

    this.clear();
    const box = new Box(this.outputPad, 0, (content) => activeTheme!.bg("userMessageBg", content));
    box.addChild(
      new Markdown(
        `❯ ${this.text}`,
        0,
        0,
        getMarkdownTheme(),
        {
          color: (content) => content.startsWith("❯ ")
            ? activeTheme!.fg(promptMarker(), "❯ ") + activeTheme!.fg("userMessageText", content.slice(2))
            : activeTheme!.fg("userMessageText", content),
        },
        { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
      ),
    );
    this.addChild(box);
  };
}

export default function (pi: ExtensionAPI) {
  patchUserMessageRenderer();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") activeTheme = ctx.ui.theme as Theme;
  });
}
