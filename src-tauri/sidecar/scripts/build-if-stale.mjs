import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "main.js");
const inputs = [
	join(root, "package.json"),
	join(root, "tsconfig.json"),
	...listTypeScriptFiles(join(root, "src")),
];

function listTypeScriptFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return listTypeScriptFiles(path);
		}
		return extname(entry.name) === ".ts" ? [path] : [];
	});
}

function latestMtimeMs(paths) {
	return Math.max(...paths.map((path) => statSync(path).mtimeMs));
}

function runBuild() {
	const result = spawnSync("npm", ["run", "build"], {
		cwd: root,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	process.exit(result.status ?? 1);
}

if (!existsSync(output)) {
	console.log("[sidecar] dist/main.js missing; building dev sidecar.");
	runBuild();
}

if (latestMtimeMs(inputs) > statSync(output).mtimeMs) {
	console.log("[sidecar] dev sidecar is stale; rebuilding.");
	runBuild();
}

console.log("[sidecar] dev sidecar is up to date.");
