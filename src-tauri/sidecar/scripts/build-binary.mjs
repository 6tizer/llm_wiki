import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const optional = process.argv.includes("--optional");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "sidecar.exe" : "sidecar";
const outfile = join(root, "dist-bin", binaryName);
const generatedEntry = join(root, "dist-bin", "main-binary.generated.ts");

// Bun compile supports embedding the SDK's native binary via `with { type: "file" }`
// and `extractFromBunfs`. Other single-file runtimes need a different entry point.
const nativePackageByPlatform = {
	"darwin-arm64": "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
	"darwin-x64": "@anthropic-ai/claude-agent-sdk-darwin-x64/claude",
	"linux-arm64": "@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
	"linux-x64": "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
	"win32-arm64": "@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe",
	"win32-x64": "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
};

function run(command, args, options = {}) {
	return spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
		shell: process.platform === "win32",
		...options,
	});
}

function failOrSkip(message) {
	if (optional) {
		console.warn(`${message}; skipping optional sidecar binary build.`);
		process.exit(0);
	}
	console.error(message);
	process.exit(1);
}

const bunCheck = spawnSync("bun", ["--version"], {
	cwd: root,
	stdio: "ignore",
	shell: process.platform === "win32",
});

if (bunCheck.status !== 0) {
	failOrSkip(
		"[sidecar] Bun is required for production sidecar binary builds. Install Bun and retry.",
	);
}

mkdirSync(dirname(outfile), { recursive: true });

const nativePackage = nativePackageByPlatform[`${process.platform}-${process.arch}`];
if (!nativePackage) {
	failOrSkip(
		`[sidecar] Unsupported platform for bundled Claude native binary: ${process.platform}-${process.arch}`,
	);
}

try {
	import.meta.resolve(nativePackage);
} catch {
	failOrSkip(
		`[sidecar] Missing ${nativePackage}. Reinstall sidecar dependencies without --omit=optional.`,
	);
}

writeFileSync(
	generatedEntry,
	`import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";\n` +
		`import nativeClaudePath from "${nativePackage}" with { type: "file" };\n` +
		`import { setBundledClaudeCodeExecutablePath } from "../src/core.ts";\n` +
		`setBundledClaudeCodeExecutablePath(extractFromBunfs(nativeClaudePath));\n` +
		`await import("../src/main.ts");\n`,
	"utf8",
);

const result = run("bun", [
	"build",
	"--compile",
	generatedEntry,
	"--outfile",
	outfile,
]);

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

rmSync(generatedEntry, { force: true });

if (!existsSync(outfile)) {
	console.error(`[sidecar] Expected binary was not written: ${outfile}`);
	process.exit(1);
}

if (process.platform !== "win32") {
	chmodSync(outfile, 0o755);
}

console.log(`[sidecar] binary ready: ${outfile}`);
