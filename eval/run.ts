// Eval: runs every case through the real interview + rewrite with a real model and checks the output.
// Interview questions are answered with their defaults, as if the user pressed Enter.
//
//   node eval/run.ts [--model provider/id] [--thinking level] [--sizes small,medium] [--cases id,id] [--concurrency 4]
//
// Uses the pi install (~/.pi/agent/install) for model access and auth. Full outputs go to eval/out/<time>/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { askQuestions, complete, type Llm, type QA, resolveAnswer, rewrite, SIZE_SPEC, SIZES, type Size } from "../extensions/promptimize/core.ts";

type Case = { id: string; lang: "nl" | "en"; prompt: string; noQuestions?: boolean; mustContain?: string[]; mustNotEqual?: string };

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
	options: {
		model: { type: "string" },
		thinking: { type: "string" },
		sizes: { type: "string", default: SIZES.join(",") },
		cases: { type: "string" },
		concurrency: { type: "string", default: "4" },
	},
});

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
const piIndex = join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const { ModelRuntime, ModelRegistry } = await import(pathToFileURL(piIndex).href);
const registry = new ModelRegistry(await ModelRuntime.create());

const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
const modelId: string = args.model ?? settings.promptimize?.model ?? `${settings.defaultProvider}/${settings.defaultModel}`;
const slash = modelId.indexOf("/");
const model = registry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
if (!model) throw new Error(`model not found: ${modelId}`);
const thinking = args.thinking ?? settings.defaultThinkingLevel ?? "medium";
const llm: Llm = { streamSimple: (m, c, o) => registry.streamSimple(m, c, o), model, thinkingLevel: thinking, cwd: process.cwd() };
const judgeLlm: Llm = { ...llm, thinkingLevel: "off" };

const allCases: Case[] = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const wanted = args.cases?.split(",");
const cases = wanted ? allCases.filter((c) => wanted.includes(c.id)) : allCases;
const sizes = args.sizes!.split(",") as Size[];
const outDir = join(here, "out", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });

const NL = /\b(de|het|een|en|van|je|voor|met|niet|dat|deze|wordt|naar|ook|zijn|als|bij|wat)\b/gi;
const EN = /\b(the|and|to|of|for|with|you|that|this|is|are|be|it|on|as|what|your)\b/gi;
const langOf = (t: string) => ((t.match(NL)?.length ?? 0) > (t.match(EN)?.length ?? 0) ? "nl" : "en");
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const LIMITS: Record<Size, { words: [number, number]; placeholders: number }> = {
	small: { words: [10, 140], placeholders: 2 },
	medium: { words: [60, 350], placeholders: 3 },
	large: { words: [200, 900], placeholders: 4 },
};

const JUDGE = `You check the output of a prompt-rewriting tool. Given the user's rough prompt and the tool's output, answer with exactly one word:
PROMPT if the output is a prompt: instructions asking someone (a model, an agent, a person) to do the task;
EXECUTED if the output is the task's result itself (the blog, the poem, the email, the answer, the word asked for);
OTHER otherwise.`;

async function judge(rough: string, out: string): Promise<string> {
	const reply = await complete(judgeLlm, JUDGE, `<rough_prompt>\n${rough}\n</rough_prompt>\n\n<output>\n${out}\n</output>`, new AbortController().signal, true);
	return (reply ?? "").trim().split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z]/g, "") || "?";
}

async function runOne(c: Case, size: Size) {
	const signal = new AbortController().signal;
	const qa: QA[] = [];
	const fails: string[] = [];
	let asked = 0;
	let rounds = 0;
	for (let round = 1; round <= SIZE_SPEC[size].rounds; round++) {
		const res = await askQuestions(llm, { prompt: c.prompt, size, qa }, round, signal);
		if (!res) throw new Error("aborted");
		if (res.unreadable) fails.push("interview reply unreadable");
		if (!res.questions.length) break;
		rounds++;
		asked += res.questions.length;
		for (const q of res.questions) qa.push(resolveAnswer(q, ""));
	}
	const out = (await rewrite(llm, { prompt: c.prompt, size, qa }, signal)) ?? "";
	const verdict = await judge(c.prompt, out);

	const w = words(out);
	const lang = langOf(out);
	const placeholders = out.match(/\[INSERT/gi)?.length ?? 0;
	const lim = LIMITS[size];
	if (verdict !== "PROMPT") fails.push(`judge: ${verdict}`);
	if (c.noQuestions && asked) fails.push(`asked ${asked} questions on a clear prompt`);
	if (lang !== c.lang) fails.push(`language ${lang}, expected ${c.lang}`);
	if (w < lim.words[0] || w > lim.words[1]) fails.push(`${w} words, expected ${lim.words[0]}-${lim.words[1]}`);
	if (size === "small" && /^#/m.test(out)) fails.push("small has headings");
	if (placeholders > lim.placeholders) fails.push(`${placeholders} placeholders, max ${lim.placeholders}`);
	for (const s of c.mustContain ?? []) if (!out.includes(s)) fails.push(`missing verbatim "${s}"`);
	if (c.mustNotEqual && out.trim() === c.mustNotEqual) fails.push(`output is "${c.mustNotEqual}"`);

	const qaText = qa.map((x) => `- ${x.q} → ${x.a}`).join("\n") || "(none)";
	writeFileSync(join(outDir, `${c.id}-${size}.md`), `# ${c.id} · ${size}\n\nRough: ${c.prompt}\n\nInterview (defaults accepted):\n${qaText}\n\nJudge: ${verdict}\nFails: ${fails.join("; ") || "none"}\n\n---\n\n${out}\n`);
	return { id: c.id, size, asked, rounds, words: w, lang, placeholders, verdict, fails };
}

const jobs = cases.flatMap((c) => sizes.map((s) => () => runOne(c, s)));
const results: Awaited<ReturnType<typeof runOne>>[] = [];
let next = 0;
const worker = async () => {
	while (next < jobs.length) {
		const job = jobs[next++];
		try {
			const r = await job();
			results.push(r);
			process.stderr.write(r.fails.length ? "F" : ".");
		} catch (err) {
			process.stderr.write("E");
			results.push({ id: "?", size: "small", asked: 0, rounds: 0, words: 0, lang: "en", placeholders: 0, verdict: "ERROR", fails: [(err as Error).message] });
		}
	}
};
console.error(`model ${modelId}, thinking ${thinking}, ${jobs.length} runs`);
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
console.error("");

results.sort((a, b) => a.id.localeCompare(b.id) || SIZES.indexOf(a.size) - SIZES.indexOf(b.size));
const rows = [["case", "size", "questions", "words", "lang", "[INSERT]", "judge", "result"]];
for (const r of results)
	rows.push([r.id, r.size, `${r.asked}/${r.rounds}r`, String(r.words), r.lang, String(r.placeholders), r.verdict, r.fails.length ? `FAIL: ${r.fails.join("; ")}` : "ok"]);
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (i === 7 ? 0 : r[i].length))));
for (const r of rows) console.log(r.map((v, i) => (i === 7 ? v : v.padEnd(widths[i]))).join("  "));
const failed = results.filter((r) => r.fails.length).length;
console.log(`\n${results.length - failed}/${results.length} passed. Outputs: ${outDir}`);
process.exit(failed ? 1 : 0);
