/**
 * Promptimize for pi: /promptimize or alt+p opens the popup (popup.ts).
 *
 * Settings (settings.json): "promptimize": { "model": "provider/id", "includeContext": false }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { register, type Settings } from "./popup.ts";

// alt+p only works when the terminal sends Option as Alt (Ghostty: macos-option-as-alt); ctrl+r is pi's session rename.
const SHORTCUT = "alt+p";

export default function (pi: ExtensionAPI) {
	register(pi, SHORTCUT, (ctx) => ({
		settings: (pi.getSettings() as { promptimize?: Settings }).promptimize ?? {},
		findModel: (id) => {
			const slash = id.indexOf("/");
			return slash > 0 ? ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1)) : undefined;
		},
		// Same list /model shows: the scoped models when set, else every model with auth.
		models: () => (ctx.scopedModels.length ? ctx.scopedModels.map((s) => s.model) : [...ctx.modelRegistry.getAvailable()]),
		streamSimple: (m, c, o) => ctx.modelRegistry.streamSimple(m as never, c as never, o as never),
		thinkingLevel: ctx.thinkingLevel,
		newEditor: (tui, theme) => new Editor(tui, theme),
	}));
}
