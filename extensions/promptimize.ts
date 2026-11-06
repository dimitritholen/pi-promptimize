/**
 * Promptimize: /promptimize, ctrl+r or alt+p opens a popup where you type a vague prompt and
 * pick a size (small / medium / large). The model first interviews you inside the popup when
 * the prompt leaves real gaps (up to 3 rounds), then writes the optimized prompt. The result
 * lands in the main editor, ready to edit or send.
 */
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type Focusable, Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ctrl+r works everywhere; alt+p only when the terminal sends Option as Alt (Ghostty: macos-option-as-alt).
const SHORTCUTS = ["ctrl+r", "alt+p"] as const;
const SIZES = ["small", "medium", "large"] as const;
type Size = (typeof SIZES)[number];
const MAX_ROUNDS = 3;
const MAX_QUESTIONS = 4;

const SIZE_RULES: Record<Size, string> = {
	small:
		"SIZE: SMALL. A terse prompt: 1 to 6 lines, no headings. State the objective, the few constraints that change the result, and the expected output. Every word must earn its place.",
	medium:
		"SIZE: MEDIUM. A compact structured prompt of roughly 100 to 250 words, using short Markdown sections such as Goal, Context, Requirements and Output. Include only what measurably improves the result.",
	large:
		"SIZE: LARGE. A complete, well-steered prompt: role and context, a clear objective with bounded scope, a step-by-step approach where it helps, positively framed constraints, edge cases to handle, a quality bar or self-check before answering, and an explicit output contract (format, length, structure). Add 1 to 3 short examples only when format or style is non-obvious. Thorough, but no padding.",
};

// Both prompts are distilled from the promptimize skill (analyze → interview → rewrite).
const INTERVIEW_PROMPT = `You are a senior prompt engineer. Before rewriting the user's rough prompt, you decide whether to ask them questions first.

Silently rate how clear and complete the rough prompt is, taking the interview answers so far into account. If it is about 8/10 or better, or the remaining gaps are trivia, ask nothing.

Otherwise ask at most ${MAX_QUESTIONS} short questions whose answers would change the optimized prompt the most: goal, audience, context, constraints, output format, quality bar, or external material (files, sites, screenshots) the model should use. Ask only what changes the output. Never repeat a question that was already asked. Ask in the user's language.

Reply with JSON only, no prose and no code fence: {"questions": ["...", "..."]}. An empty list means you have enough.`;

const REWRITE_PROMPT = `You are a senior prompt engineer. Turn the user's rough prompt, together with their interview answers, into one optimized prompt that lets the target model do its best work.

Work silently: find remaining ambiguities, gaps and unstated assumptions, fold in everything the interview answers settled, decide what context, constraints or output contract would measurably improve the result, then rewrite. Apply current best practice: clear objective, bounded scope, explicit output contract, positively framed constraints, source material below the instruction.

Hard rules:
- Output ONLY the optimized prompt. No preamble, no explanation, no code fence, no follow-up offer.
- Preserve intent. Add structure and clarity, never invented facts.
- For a missing specific (name, date, number, file, audience), or a question the user skipped, insert [INSERT X] rather than guessing.
- Match the user's language: a Dutch rough prompt gives a Dutch optimized prompt.
- Stay model-agnostic: Markdown headings, no vendor-specific tags.
- Honour the requested size exactly.`;

type QA = { q: string; a: string };

const textOf = (content: { type: string }[]) =>
	content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

function stripFence(text: string): string {
	const m = text.trim().match(/^```[\w-]*\n([\s\S]*?)\n```$/);
	return (m ? m[1] : text).trim();
}

function userInput(prompt: string, size: Size, qa: QA[]): string {
	const answers = qa.length
		? `\n\n# Interview\n\n${qa.map((x) => `Q: ${x.q}\nA: ${x.a || "(skipped)"}`).join("\n\n")}`
		: "";
	return `${SIZE_RULES[size]}\n\n# Rough prompt\n\n${prompt}${answers}`;
}

/** Model reply text, or null when aborted. */
async function complete(ctx: ExtensionContext, systemPrompt: string, text: string, signal: AbortSignal): Promise<string | null> {
	const msg: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
	const res = await ctx.modelRegistry.complete(ctx.model!, { systemPrompt, messages: [msg] }, { signal, cacheRetention: "none" });
	if (res.stopReason === "aborted") return null;
	if (res.stopReason === "error") throw new Error(res.errorMessage ?? "model error");
	return textOf(res.content);
}

/** Questions from the model's JSON reply; an unreadable reply counts as "no questions", so the flow still finishes. */
export function parseQuestions(reply: string): string[] {
	try {
		const json = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
		const qs = Array.isArray(json.questions) ? json.questions : [];
		return qs.filter((q: unknown): q is string => typeof q === "string" && q.trim() !== "").map((q: string) => q.trim()).slice(0, MAX_QUESTIONS);
	} catch {
		return [];
	}
}

class PromptimizePopup implements Focusable {
	private stage: "compose" | "interview" = "compose";
	private zone = 0; // compose stage: 0 = prompt, 1 = size, 2 = generate button
	private sizeIdx = 1;
	private editor: Editor; // the rough prompt
	private answer: Editor; // interview answers
	private prompt = "";
	private qa: QA[] = [];
	private questions: string[] = [];
	private qIdx = 0;
	private round = 0;
	private status: string | undefined;
	private abort: AbortController | undefined;
	private _focused = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private ctx: ExtensionContext,
		private done: (r: string | null) => void,
		initial: string,
	) {
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
		this.editor.setText(initial);
		// Editor clears itself before onSubmit; put the text back so it stays visible.
		this.editor.onSubmit = (text) => {
			this.editor.setText(text);
			void this.start();
		};
		this.answer = new Editor(tui, editorTheme(() => true));
		this.answer.onSubmit = (text) => {
			this.qa.push({ q: this.questions[this.qIdx], a: text.trim() });
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

	private setZone(z: number) {
		this.zone = (z + 3) % 3;
		this.syncFocus();
		this.tui.requestRender();
	}

	private get size(): Size {
		return SIZES[this.sizeIdx];
	}

	/** Runs one model call with a status line; null when cancelled or failed (status says which). */
	private async call(label: string, system: string): Promise<string | null> {
		this.abort = new AbortController();
		this.status = this.theme.fg("accent", `${label} with ${this.ctx.model!.id}…  (Esc cancels)`);
		this.tui.requestRender();
		try {
			const out = await complete(this.ctx, system, userInput(this.prompt, this.size, this.qa), this.abort.signal);
			this.status = out === null ? this.theme.fg("muted", "Cancelled.") : undefined;
			return out;
		} catch (err) {
			this.status = this.theme.fg("error", `Failed: ${(err as Error).message}`);
			return null;
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
		if (!this.ctx.model) {
			this.status = this.theme.fg("error", "No model selected.");
			return this.tui.requestRender();
		}
		this.qa = [];
		this.round = 0;
		await this.nextRound();
	}

	private async nextRound() {
		if (this.round >= MAX_ROUNDS) return this.finish();
		const reply = await this.call("Checking what to ask", INTERVIEW_PROMPT);
		if (reply === null) return; // cancelled or failed: stay where we are, Enter retries
		const qs = parseQuestions(reply);
		if (!qs.length) return this.finish();
		this.questions = qs;
		this.qIdx = 0;
		this.round++;
		this.stage = "interview";
		this.answer.setText("");
		this.syncFocus();
		this.tui.requestRender();
	}

	private async finish() {
		// Questions left open in this round go in as skipped, so the rewrite uses placeholders for them.
		if (this.stage === "interview")
			for (; this.qIdx < this.questions.length; this.qIdx++) this.qa.push({ q: this.questions[this.qIdx], a: "" });
		const out = await this.call(`Writing the ${this.size} prompt`, REWRITE_PROMPT);
		if (out) this.done(stripFence(out));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.abort) this.abort.abort();
			else this.done(null);
			return;
		}
		if (this.abort) return; // ignore input while the model works

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
		} else if (matchesKey(data, Key.enter) || (this.zone === 2 && data === " ")) {
			void this.start();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.max(20, width);
		const inner = w - 4; // "│ " + content + " │"
		const lines: string[] = [""];
		const pad = (s: string) => s;
		const wrap = (s: string) => wrapTextWithAnsi(s, inner);

		if (this.stage === "interview") {
			const first = this.prompt.split("\n")[0];
			lines.push(pad(`${t.fg("muted", "Prompt:")} ${t.fg("dim", first)}`));
			lines.push(pad(`${t.fg("muted", "Size:")} ${t.fg("dim", this.size)}`));
			lines.push("");
			for (const x of this.qIdx ? this.qa.slice(-this.qIdx) : []) {
				lines.push(...wrap(t.fg("dim", `Q: ${x.q}`)));
				lines.push(...wrap(t.fg("dim", `A: ${x.a || "(skipped)"}`)));
			}
			if (this.qIdx < this.questions.length) {
				lines.push(pad(t.fg("accent", `Round ${this.round}/${MAX_ROUNDS} · question ${this.qIdx + 1}/${this.questions.length}`)));
				lines.push(...wrap(t.fg("text", t.bold(this.questions[this.qIdx]))));
				for (const l of this.answer.render(inner)) lines.push(pad(l));
			}
			lines.push("");
			if (this.status) lines.push(...wrap(this.status));
			lines.push(...wrap(t.fg("dim", "Enter answer (empty skips) • Shift+Enter newline • Tab stop asking and generate • Esc close")));
		} else {
			lines.push(pad(t.fg(this.zone === 0 ? "text" : "muted", "Your rough prompt:")));
			for (const l of this.editor.render(inner)) lines.push(pad(l));
			lines.push("");

			const radios = SIZES.map((s, i) => {
				const label = `${i === this.sizeIdx ? "(•)" : "( )"} ${s[0].toUpperCase()}${s.slice(1)}`;
				if (i === this.sizeIdx) return t.fg(this.zone === 1 ? "accent" : "text", label);
				return t.fg("muted", label);
			}).join("   ");
			lines.push(pad(`${t.fg(this.zone === 1 ? "text" : "muted", "Size:")}  ${radios}`));
			lines.push("");

			const btn = " Generate ";
			lines.push(pad(this.zone === 2 ? t.bg("selectedBg", t.fg("accent", t.bold(`▶${btn}`))) : t.fg("muted", `[${btn}]`)));
			lines.push("");
			if (this.status) lines.push(...wrap(this.status));
			lines.push(...wrap(t.fg("dim", "Tab field • ←/→ size • Enter generate • Shift+Enter newline • Esc close")));
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

async function open(ctx: ExtensionContext, initial = "") {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("promptimize needs interactive mode", "error");
		return;
	}
	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => new PromptimizePopup(tui, theme, ctx, done, initial),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 50 } },
	);
	if (!result) return;
	ctx.ui.setEditorText(result);
	ctx.ui.notify("Optimized prompt is in the editor. Edit or send it.", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("promptimize", {
		description: "Optimize a rough prompt (small / medium / large) in a popup, with a short interview first",
		handler: async (args, ctx) => open(ctx, args.trim()),
	});
	for (const key of SHORTCUTS)
		pi.registerShortcut(key, { description: "Open the promptimize popup", handler: async (ctx) => open(ctx) });
}
