import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const optional = process.argv.includes("--optional");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "sidecar.exe" : "sidecar";
const outfile = join(root, "dist-bin", binaryName);

function run(command, args, options = {}) {
	return spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
		shell: process.platform === "win32",
		...options,
	});
}

const bunCheck = spawnSync("bun", ["--version"], {
	cwd: root,
	stdio: "ignore",
	shell: process.platform === "win32",
});

if (bunCheck.status !== 0) {
	const message =
		"[sidecar] Bun is not installed; skipping optional sidecar binary build.";
	if (optional) {
		console.warn(message);
		process.exit(0);
	}
	console.error(
		"[sidecar] Bun is required for production sidecar binary builds. Install Bun and retry.",
	);
	process.exit(1);
}

mkdirSync(dirname(outfile), { recursive: true });

const result = run("bun", [
	"build",
	"--compile",
	"src/main.ts",
	"--outfile",
	outfile,
]);

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

if (!existsSync(outfile)) {
	console.error(`[sidecar] Expected binary was not written: ${outfile}`);
	process.exit(1);
}

if (process.platform !== "win32") {
	chmodSync(outfile, 0o755);
}

console.log(`[sidecar] binary ready: ${outfile}`);
