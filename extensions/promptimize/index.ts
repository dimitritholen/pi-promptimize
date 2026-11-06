/**
 * Promptimize: /promptimize, ctrl+r or alt+p opens a popup where you type a vague prompt, pick a
 * size (small / medium / large) and optionally include the recent session context. The model
 * interviews you when the prompt leaves real gaps, then shows the optimized prompt for review:
 * use it, regenerate it, or switch size. "Use" puts it in the main editor.
 *
 * Settings (settings.json): "promptimize": { "model": "provider/id", "includeContext": false }
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type Focusable, Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { askQuestions, type Llm, type QA, type Question, type Request, resolveAnswer, rewrite, SIZE_SPEC, SIZES, type Size } from "./core.ts";

// ctrl+r works everywhere; alt+p only when the terminal sends Option as Alt (Ghostty: macos-option-as-alt).
const SHORTCUTS = ["ctrl+r", "alt+p"] as const;
const CONTEXT_MESSAGES = 10;
const CONTEXT_CHARS = 16_000;

interface Settings {
	model?: string;
	includeContext?: boolean;
}

// What the popup remembers between openings in this pi process.
const last = { prompt: "", sizeIdx: 1, includeContext: undefined as boolean | undefined };

/** The recent conversation on the current branch, serialized and capped; undefined when there is none. */
function sessionContext(ctx: ExtensionContext): string | undefined {
	const messages = ctx.sessionManager
		.getBranch()
		.flatMap((e) => (e.type === "message" ? [e.message] : []))
		.slice(-CONTEXT_MESSAGES);
	if (!messages.length) return;
	const text = serializeConversation(convertToLlm(messages));
	return text.length > CONTEXT_CHARS ? `…${text.slice(-CONTEXT_CHARS)}` : text;
}

/** settings.promptimize.model when set and known, else the session model. */
function pickModel(ctx: ExtensionContext, settings: Settings): { model: ExtensionContext["model"]; warning?: string } {
	const id = settings.model?.trim();
	if (!id) return { model: ctx.model };
	const slash = id.indexOf("/");
	const model = slash > 0 ? ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1)) : undefined;
	if (model) return { model };
	return { model: ctx.model, warning: `promptimize: model "${id}" not found, using the session model.` };
}

type Stage = "compose" | "interview" | "result";
const ZONES = 4; // compose stage: 0 prompt, 1 size, 2 context, 3 generate

class PromptimizePopup implements Focusable {
	private stage: Stage = "compose";
	private zone = 0;
	private sizeIdx: number;
	private includeContext: boolean;
	private editor: Editor; // the rough prompt
	private answer: Editor; // interview answers
	private prompt = "";
	private qa: QA[] = [];
	private questions: Question[] = [];
	private qIdx = 0;
	private round = 0;
	private result = "";
	private scroll = 0;
	private status: string | undefined;
	private abort: AbortController | undefined;
	private _focused = false;
	private tui: TUI;
	private theme: Theme;
	private ctx: ExtensionContext;
	private llm: Llm;
	private done: (r: string | null) => void;

	constructor(tui: TUI, theme: Theme, ctx: ExtensionContext, llm: Llm, settings: Settings, done: (r: string | null) => void, initial: string) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.llm = llm;
		this.done = done;
		this.sizeIdx = last.sizeIdx;
		this.includeContext = last.includeContext ?? settings.includeContext ?? false;
		const editorTheme = (active: () => boolean): EditorTheme => ({
			borderColor: (s) => theme.fg(active() ? "accent" : "dim", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		});
		this.editor = new Editor(tui, editorTheme(() => this.zone === 0));
		this.editor.setText(initial || last.prompt);
		// Editor clears itself before onSubmit; put the text back so it stays visible.
		this.editor.onSubmit = (text) => {
			this.editor.setText(text);
			void this.start();
		};
		this.answer = new Editor(tui, editorTheme(() => true));
		this.answer.onSubmit = (text) => {
			this.qa.push(resolveAnswer(this.questions[this.qIdx], text));
			this.qIdx++;
			if (this.qIdx < this.questions.length) this.tui.requestRender();
			else void this.nextRound();
		};
	}

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.syncFocus();
	}

	// Only the visible, active editor gets focus, so the IME cursor lands in the right place.
	private syncFocus() {
		this.editor.focused = this._focused && this.stage === "compose" && this.zone === 0;
		this.answer.focused = this._focused && this.stage === "interview";
	}

	private setStage(s: Stage) {
		this.stage = s;
		this.syncFocus();
		this.tui.requestRender();
	}

	private setZone(z: number) {
		this.zone = (z + ZONES) % ZONES;
		this.syncFocus();
		this.tui.requestRender();
	}

	private get size(): Size {
		return SIZES[this.sizeIdx];
	}

	private request(): Request {
		return { prompt: this.prompt, size: this.size, qa: this.qa, context: this.includeContext ? sessionContext(this.ctx) : undefined };
	}

	private close(result: string | null) {
		last.prompt = result === null ? this.editor.getText() : ""; // a used prompt starts fresh next time
		last.sizeIdx = this.sizeIdx;
		last.includeContext = this.includeContext;
		this.done(result);
	}

	/** Runs one model step with a status line; undefined when cancelled or failed (status says which). */
	private async run<T>(label: string, fn: (signal: AbortSignal) => Promise<T | null>): Promise<T | undefined> {
		this.abort = new AbortController();
		this.status = this.theme.fg("accent", `${label}…  (Esc cancels)`);
		this.tui.requestRender();
		try {
			const out = await fn(this.abort.signal);
			this.status = out === null ? this.theme.fg("muted", "Cancelled.") : undefined;
			return out ?? undefined;
		} catch (err) {
			this.status = this.theme.fg("error", `Failed: ${(err as Error).message}`);
			return undefined;
		} finally {
			this.abort = undefined;
			this.tui.requestRender();
		}
	}

	private async start() {
		if (this.abort) return;
		this.prompt = this.editor.getText().trim();
		if (!this.prompt) {
			this.status = this.theme.fg("warning", "Type a prompt first.");
			return this.setZone(0);
		}
		this.qa = [];
		this.round = 0;
		await this.nextRound();
	}

	private async nextRound() {
		if (this.round >= SIZE_SPEC[this.size].rounds) return this.finish();
		const res = await this.run("Checking what to ask", (signal) => askQuestions(this.llm, this.request(), this.round + 1, signal));
		if (!res) return; // cancelled or failed: stay where we are, Enter retries
		if (res.unreadable) this.ctx.ui.notify("promptimize: the interview reply was unreadable, so it was skipped.", "warning");
		if (!res.questions.length) return this.finish();
		this.questions = res.questions;
		this.qIdx = 0;
		this.round++;
		this.answer.setText("");
		this.setStage("interview");
	}

	private async finish() {
		// Questions left open in this round (Tab) take their default.
		if (this.stage === "interview")
			for (; this.qIdx < this.questions.length; this.qIdx++) this.qa.push(resolveAnswer(this.questions[this.qIdx], ""));
		const out = await this.run(`Writing the ${this.size} prompt`, (signal) => rewrite(this.llm, this.request(), signal));
		if (out === undefined) return;
		this.result = out;
		this.scroll = 0;
		this.setStage("result");
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.abort) this.abort.abort();
			else this.close(null);
			return;
		}
		if (this.abort) return; // ignore input while the model works

		if (this.stage === "result") return this.resultInput(data);
		if (this.stage === "interview") {
			if (matchesKey(data, Key.tab)) void this.finish();
			else if (this.qIdx >= this.questions.length) {
				if (matchesKey(data, Key.enter)) void this.nextRound(); // retry after a cancel or error
			} else this.answer.handleInput(data);
			return this.tui.requestRender();
		}

		if (matchesKey(data, Key.tab)) return this.setZone(this.zone + 1);
		if (matchesKey(data, Key.shift("tab"))) return this.setZone(this.zone - 1);
		if (this.zone === 0) {
			this.editor.handleInput(data); // Enter submits, Shift+Enter inserts a newline
		} else if (this.zone === 1 && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
			this.sizeIdx = (this.sizeIdx + (matchesKey(data, Key.left) ? 2 : 1)) % 3;
		} else if (["1", "2", "3"].includes(data)) {
			this.sizeIdx = Number(data) - 1;
		} else if (this.zone === 2 && (data === " " || matchesKey(data, Key.enter))) {
			this.includeContext = !this.includeContext;
		} else if (matchesKey(data, Key.enter) || (this.zone === 3 && data === " ")) {
			void this.start();
		}
		this.tui.requestRender();
	}

	private resultInput(data: string) {
		if (matchesKey(data, Key.enter)) return this.close(this.result);
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll++;
		else if (data === "r") void this.finish();
		else if (data === "e") {
			this.status = undefined;
			this.zone = 0;
			return this.setStage("compose");
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || ["1", "2", "3"].includes(data)) {
			// Another size keeps the interview answers; only the rewrite runs again.
			this.sizeIdx = ["1", "2", "3"].includes(data) ? Number(data) - 1 : (this.sizeIdx + (matchesKey(data, Key.left) ? 2 : 1)) % 3;
			void this.finish();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.max(20, width);
		const inner = w - 4; // "│ " + content + " │"
		const lines: string[] = [""];
		const wrap = (s: string) => wrapTextWithAnsi(s, inner);
		const radios = (active: boolean) =>
			SIZES.map((s, i) => {
				const label = `${i === this.sizeIdx ? "(•)" : "( )"} ${s[0].toUpperCase()}${s.slice(1)}`;
				return i === this.sizeIdx ? t.fg(active ? "accent" : "text", label) : t.fg("muted", label);
			}).join("   ");
		const status = () => (this.status ? wrap(this.status) : []);

		if (this.stage === "result") {
			lines.push(`${t.fg("muted", "Size:")}  ${radios(true)}`);
			lines.push("");
			const body = this.result.split("\n").flatMap((l) => (l ? wrap(t.fg("text", l)) : [""]));
			const room = Math.max(6, (this.tui.terminal?.rows ?? 40) - 14);
			this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
			lines.push(...body.slice(this.scroll, this.scroll + room));
			if (body.length > room)
				lines.push(t.fg("dim", `↑/↓ scroll · lines ${this.scroll + 1}–${Math.min(body.length, this.scroll + room)} of ${body.length}`));
			lines.push("");
			lines.push(...status());
			lines.push(...wrap(t.fg("dim", "Enter use • r regenerate • ←/→ or 1-3 other size • e edit prompt • Esc close")));
		} else if (this.stage === "interview") {
			lines.push(`${t.fg("muted", "Prompt:")} ${t.fg("dim", this.prompt.split("\n")[0])}`);
			lines.push(`${t.fg("muted", "Size:")} ${t.fg("dim", this.size)}`);
			lines.push("");
			for (const x of this.qIdx ? this.qa.slice(-this.qIdx) : []) {
				lines.push(...wrap(t.fg("dim", `Q: ${x.q}`)));
				lines.push(...wrap(t.fg("dim", `A: ${x.source === "skipped" ? "(skipped)" : x.a}${x.source === "default" ? " (default)" : ""}`)));
			}
			const q = this.questions[this.qIdx];
			if (q) {
				lines.push(t.fg("accent", `Round ${this.round}/${SIZE_SPEC[this.size].rounds} · question ${this.qIdx + 1}/${this.questions.length}`));
				lines.push(...wrap(t.fg("text", t.bold(q.question))));
				if (q.default) lines.push(...wrap(t.fg("muted", `Default: ${q.default}`)));
				lines.push(...this.answer.render(inner));
			}
			lines.push("");
			lines.push(...status());
			lines.push(...wrap(t.fg("dim", "Enter answer (empty takes the default, - skips) • Shift+Enter newline • Tab use defaults and generate • Esc close")));
		} else {
			lines.push(t.fg(this.zone === 0 ? "text" : "muted", "Your rough prompt:"));
			lines.push(...this.editor.render(inner));
			lines.push("");
			lines.push(`${t.fg(this.zone === 1 ? "text" : "muted", "Size:")}     ${radios(this.zone === 1)}`);
			const box = `${this.includeContext ? "[x]" : "[ ]"} Include recent session context`;
			lines.push(`${t.fg(this.zone === 2 ? "text" : "muted", "Context:")}  ${t.fg(this.zone === 2 ? "accent" : this.includeContext ? "text" : "muted", box)}`);
			lines.push("");
			const btn = " Generate ";
			lines.push(this.zone === 3 ? t.bg("selectedBg", t.fg("accent", t.bold(`▶${btn}`))) : t.fg("muted", `[${btn}]`));
			lines.push("");
			lines.push(...status());
			lines.push(...wrap(t.fg("dim", "Tab field • ←/→ size • Space toggle • Enter generate • Shift+Enter newline • Esc close")));
		}
		lines.push("");

		// Solid panel: own background on every cell (re-applied after inner resets) and a rounded accent frame.
		const bg = t.getBgAnsi("customMessageBg");
		const fill = (s: string) => bg + s.replace(/\x1b\[(0|49)?m/g, (m) => m + bg) + "\x1b[49m";
		const bar = (s: string) => t.fg("accent", s);
		const title = ` ${t.bold("Promptimize")} `;
		return [
			bar(`╭─${title}${"─".repeat(Math.max(0, w - 3 - visibleWidth(title)))}╮`),
			...lines.map((l) => bar("│") + fill(` ${truncateToWidth(l, inner, "…", true)} `) + bar("│")),
			bar(`╰${"─".repeat(w - 2)}╯`),
		];
	}

	invalidate(): void {
		this.editor.invalidate();
		this.answer.invalidate();
	}
}

async function open(pi: ExtensionAPI, ctx: ExtensionContext, initial = "") {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("promptimize needs interactive mode", "error");
		return;
	}
	const settings: Settings = (pi.getSettings() as { promptimize?: Settings }).promptimize ?? {};
	const { model, warning } = pickModel(ctx, settings);
	if (warning) ctx.ui.notify(warning, "warning");
	if (!model) {
		ctx.ui.notify("promptimize: no model selected.", "error");
		return;
	}
	const llm: Llm = {
		streamSimple: (m, c, o) => ctx.modelRegistry.streamSimple(m as never, c as never, o as never),
		model,
		thinkingLevel: ctx.thinkingLevel,
		cwd: ctx.cwd,
	};
	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => new PromptimizePopup(tui, theme, ctx, llm, settings, done, initial),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 50 } },
	);
	if (!result) return;
	ctx.ui.setEditorText(result);
	ctx.ui.notify("Optimized prompt is in the editor. Edit or send it.", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("promptimize", {
		description: "Optimize a rough prompt (small / medium / large) in a popup, with a short interview first",
		handler: async (args, ctx) => open(pi, ctx, args.trim()),
	});
	for (const key of SHORTCUTS)
		pi.registerShortcut(key, { description: "Open the promptimize popup", handler: async (ctx) => open(pi, ctx) });
}
