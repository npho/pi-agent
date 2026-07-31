import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function formatWorkedFor(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const units = [
    hours > 0 ? `${hours}h` : undefined,
    minutes > 0 ? `${minutes}m` : undefined,
    seconds > 0 ? `${seconds}s` : undefined,
  ].filter((unit): unit is string => unit !== undefined);
  return `✻ Worked for ${units.join(" ") || "0s"}`;
}

export default function (pi: ExtensionAPI) {
  let promptReceivedAt: number | undefined;

  // `input` is the earliest lifecycle event for a user prompt, including a
  // prompt queued while the model is still working. Extension-generated input
  // is not a user prompt and must not reset the timer.
  pi.on("input", (event) => {
    if (event.source !== "extension") promptReceivedAt = Date.now();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // message_end handlers are middleware. If the extension was loaded more
    // than once (for example while reloading resources), a later instance sees
    // the prior instance's replacement and must leave its footer intact.
    if (event.message.content.some(
      (part) => part.type === "text" && /(?:^|\n)✻ Worked for /.test(part.text),
    )) return;

    if (promptReceivedAt === undefined) return;

    // Tool-call messages are intermediate agent work, not a reply returned to
    // the user. Likewise, wait for queued user input to finish before adding a
    // footer to the eventual final reply.
    if (event.message.content.some((part) => part.type === "toolCall") || ctx.hasPendingMessages()) return;

    // Pi may automatically retry an error response; preserve the original
    // start time so the successful retry gets the total duration instead.
    if (event.message.stopReason === "error") return;

    const footer = formatWorkedFor(Date.now() - promptReceivedAt);
    promptReceivedAt = undefined;

    const content = [...event.message.content];
    const lastTextIndex = content.map((part) => part.type).lastIndexOf("text");

    // The TUI trims each text part before rendering it. Add the footer to the
    // final text part, rather than a separate text part, so Markdown preserves
    // this blank line.
    if (lastTextIndex >= 0) {
      const lastText = content[lastTextIndex];
      if (lastText?.type === "text") {
        content[lastTextIndex] = { ...lastText, text: `${lastText.text.trimEnd()}\n\n${footer}` };
      }
    } else {
      content.push({ type: "text", text: footer });
    }

    return {
      message: {
        ...event.message,
        content,
      },
    };
  });
}
