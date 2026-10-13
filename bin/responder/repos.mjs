// The folder a message is about: the first word naming a folder directly under the repos root, else the default repo,
// else an empty scratch folder. Never the home folder: --restricted confines the file tools to cwd, so cwd = $HOME would
// hand a read-only session every file the owner has.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRepo, reposRoot, stateDir } from "./config.mjs";

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules").map((d) => d.name);
  } catch {
    return [];
  }
}

export function repoFor(text) {
  const dirs = new Map(subdirs(reposRoot).map((d) => [d.toLowerCase(), d]));
  for (const word of String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []) {
    const hit = dirs.get(word) ?? dirs.get(word.replace(/[.]+$/, ""));
    if (hit) return join(reposRoot, hit);
  }
  if (defaultRepo && existsSync(defaultRepo) && statSync(defaultRepo).isDirectory()) return defaultRepo;
  const scratch = join(stateDir, "scratch");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  return scratch;
}
