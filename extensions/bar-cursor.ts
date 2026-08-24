import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

class BarCursorEditor extends CustomEditor {
	render(width: number): string[] {
		return super.render(width).map((line) => {
			// Pi places CURSOR_MARKER immediately before its inverse-video fake
			// cursor. Preserve the marker for the terminal hardware cursor while
			// removing the inverse-video rendering.
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex < 0) return line;

			const cursorStart = markerIndex + CURSOR_MARKER.length;
			const inverseStart = "\x1b[7m";
			const reset = "\x1b[0m";

			if (!line.startsWith(inverseStart, cursorStart)) return line;

			const textStart = cursorStart + inverseStart.length;
			const resetIndex = line.indexOf(reset, textStart);
			if (resetIndex < 0) return line;

			return line.slice(0, cursorStart) + line.slice(textStart, resetIndex) + line.slice(resetIndex + reset.length);
		});
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new BarCursorEditor(tui, theme, keybindings),
		);
	});
}
