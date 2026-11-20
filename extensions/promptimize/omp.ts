/**
 * Promptimize for omp (oh-my-pi): /promptimize or ctrl+alt+p opens the popup (popup.ts).
 * omp has no extension settings API, so the popup starts with the session model.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Editor, getSymbolTheme } from "@oh-my-pi/pi-tui";
import type { Llm } from "./core.ts";
import { register } from "./popup.ts";

// alt+p is omp's model switcher and alt+shift+p toggles plan mode.
const SHORTCUT = "ctrl+alt+p";

export default function (pi: ExtensionAPI) {
	// popup.ts is typed against pi's API; omp's command and shortcut contexts carry every member it uses.
	register(pi as never, SHORTCUT, (piCtx) => {
		const ctx = piCtx as unknown as ExtensionContext;
		const level = pi.getThinkingLevel();
		const streamSimple: Llm["streamSimple"] = (model, context, options) => ({
			result: async () => {
				const m = model as Parameters<typeof completeSimple>[0];
				const signal = options.signal instanceof AbortSignal ? options.signal : undefined;
				// The lookup can refresh an OAuth token and ignores the signal; stop waiting on Esc.
				const aborted = Promise.withResolvers<undefined>();
				signal?.addEventListener("abort", () => aborted.resolve(undefined), { once: true });
				const auth = signal?.aborted ? undefined : await Promise.race([ctx.modelRegistry.getApiKeyAndHeaders(m), aborted.promise]);
				if (!auth || signal?.aborted) return { stopReason: "aborted", content: [] };
				if (!auth.ok) return { stopReason: "error", errorMessage: auth.error, content: [] };
				return completeSimple(m, context as never, { ...options, apiKey: auth.apiKey, headers: auth.headers });
			},
		});
		return {
			settings: {},
			findModel: (id) => ctx.models.resolve(id),
			models: () => ctx.models.list(),
			streamSimple,
			thinkingLevel: level === "inherit" ? undefined : level,
			newEditor: (_tui, theme) => new Editor(theme as never),
			symbols: getSymbolTheme(),
		};
	});
}
