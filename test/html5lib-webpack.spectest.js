"use strict";

// Compiles every html5lib-tests tokenizer input as a webpack HTML entry
// (experiments.html), so the full pipeline — parse, build the AST, handle, and
// generate — is exercised on the same adversarial corpus, not just the
// tokenizer. URL extraction is off so nothing needs to resolve; the point is
// that webpack handles malformed input gracefully (no crash/hang) and any
// emitted errors/warnings are real, not internal exceptions.

const fs = require("fs");
const path = require("path");
const { Volume, createFsFromVolume } = require("memfs");
const webpack = require("..");

const tokenizerDir = path.resolve(__dirname, "./html5lib-tests/tokenizer");
const SKIP_FILES = new Set(["xmlViolation.test", "pendingSpecChanges.test"]);
// A graceful webpack error/warning on malformed input is fine; an internal
// exception leaking through (parser/generator bug) is not.
const INTERNAL =
	/TypeError|RangeError|Cannot read|is not a function|Maximum call stack|of undefined|of null/;

const unescape = (s) =>
	s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) =>
		String.fromCharCode(Number.parseInt(h, 16))
	);

/**
 * @returns {string[]} every Data-state tokenizer input
 */
const loadInputs = () => {
	/** @type {string[]} */
	const inputs = [];
	for (const file of fs.readdirSync(tokenizerDir)) {
		if (!file.endsWith(".test") || SKIP_FILES.has(file)) continue;
		const data = JSON.parse(
			fs.readFileSync(path.join(tokenizerDir, file), "utf8")
		);
		for (const t of data.tests || []) {
			if (!(t.initialStates || ["Data state"]).includes("Data state")) continue;
			inputs.push(t.doubleEscaped ? unescape(t.input) : t.input);
		}
	}
	return inputs;
};

/**
 * Compile a batch of inputs as separate HTML entries in one compilation.
 * @param {string[]} inputs HTML sources
 * @returns {Promise<{ err?: string, messages: string[] }>} build result
 */
const buildBatch = (inputs) =>
	new Promise((resolve) => {
		const mfs = createFsFromVolume(new Volume());
		mfs.mkdirSync("/src", { recursive: true });
		/** @type {Record<string, string>} */
		const entry = {};
		for (const [i, input] of inputs.entries()) {
			mfs.writeFileSync(`/src/c${i}.html`, input);
			entry[`c${i}`] = `./c${i}.html`;
		}
		const compiler = webpack({
			context: "/src",
			mode: "production",
			entry,
			output: { path: "/out", filename: "[name].js" },
			target: "web",
			experiments: { html: true },
			module: { parser: { html: { sources: false } } }
		});
		compiler.inputFileSystem = mfs;
		compiler.outputFileSystem = mfs;
		compiler.run((err, stats) => {
			if (err) {
				resolve({ err: String(err.message), messages: [] });
				return;
			}
			const json = stats.toJson({ errors: true, warnings: true });
			const messages = [...json.errors, ...json.warnings].map((m) => m.message);
			compiler.close(() => resolve({ messages }));
		});
	});

const hasSubmodule =
	fs.existsSync(tokenizerDir) && fs.readdirSync(tokenizerDir).length > 0;

describe("html5lib-tests webpack build", () => {
	if (!hasSubmodule) {
		it("submodule not initialized (run `git submodule update --init test/html5lib-tests`)", () => {
			// No-op: the conformance data is an optional git submodule.
		});

		return;
	}

	it("compiles every tokenizer input as an HTML entry without crashing", async () => {
		const inputs = loadInputs();
		/** @type {string[]} */
		const failures = [];
		const BATCH = 400;
		for (let i = 0; i < inputs.length; i += BATCH) {
			const result = await buildBatch(inputs.slice(i, i + BATCH));
			if (result.err) {
				failures.push(
					`batch@${i}: compiler error: ${result.err.slice(0, 200)}`
				);
				continue;
			}
			for (const message of result.messages) {
				if (INTERNAL.test(message)) {
					failures.push(
						`batch@${i}: internal error: ${message
							.split("\n")[0]
							.slice(0, 160)}`
					);
				}
			}
		}
		if (failures.length > 0) {
			throw new Error(
				`${failures.length} webpack HTML build failure(s):\n${failures.join(
					"\n"
				)}`
			);
		}
	}, 180000);
});
