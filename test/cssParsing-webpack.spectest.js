"use strict";

// Compiles every css-parsing-tests input as a webpack CSS entry
// (experiments.css), exercising the full pipeline — parse, build the AST,
// handle, and generate — on the same corpus, not just the tokenizer. `@import`
// and `url()` extraction is off so nothing needs to resolve; the point is that
// webpack handles malformed input gracefully (no crash/hang) and any emitted
// errors/warnings are real, not internal exceptions.

const fs = require("fs");
const path = require("path");
const { Volume, createFsFromVolume } = require("memfs");
const webpack = require("..");

const casesDir = path.resolve(__dirname, "./css-parsing-tests");
// A graceful webpack error/warning on malformed input is fine; an internal
// exception leaking through (parser/generator bug) is not.
const INTERNAL =
	/TypeError|RangeError|Cannot read|is not a function|Maximum call stack|of undefined|of null/;

/**
 * @returns {string[]} every CSS input (handles the `stylesheet_bytes` shape)
 */
const loadInputs = () => {
	/** @type {string[]} */
	const inputs = [];
	for (const file of fs.readdirSync(casesDir)) {
		if (!file.endsWith(".json")) continue;
		const data = JSON.parse(fs.readFileSync(path.join(casesDir, file), "utf8"));
		for (let i = 0; i < data.length; i += 2) {
			const value = data[i];
			if (typeof value === "string") {
				inputs.push(value);
			} else if (value && typeof value.css_bytes === "string") {
				inputs.push(value.css_bytes);
			}
		}
	}
	return inputs;
};

/**
 * Compile a batch of inputs as separate CSS entries in one compilation.
 * @param {string[]} inputs CSS sources
 * @returns {Promise<{ err?: string, messages: string[] }>} build result
 */
const buildBatch = (inputs) =>
	new Promise((resolve) => {
		const mfs = createFsFromVolume(new Volume());
		mfs.mkdirSync("/src", { recursive: true });
		/** @type {Record<string, string>} */
		const entry = {};
		for (const [i, input] of inputs.entries()) {
			mfs.writeFileSync(`/src/c${i}.css`, input);
			entry[`c${i}`] = `./c${i}.css`;
		}
		const compiler = webpack({
			context: "/src",
			mode: "production",
			entry,
			output: {
				path: "/out",
				filename: "[name].js",
				cssFilename: "[name].css"
			},
			target: "web",
			experiments: { css: true },
			module: { parser: { css: { import: false, url: false } } }
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
	fs.existsSync(casesDir) && fs.readdirSync(casesDir).length > 0;

describe("css-parsing-tests webpack build", () => {
	if (!hasSubmodule) {
		it("submodule not initialized (run `git submodule update --init test/css-parsing-tests`)", () => {
			// No-op: the conformance data is an optional git submodule.
		});

		return;
	}

	it("compiles every input as a CSS entry without crashing", async () => {
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
				`${failures.length} webpack CSS build failure(s):\n${failures.join(
					"\n"
				)}`
			);
		}
	}, 180000);
});
