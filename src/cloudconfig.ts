import { resolveConfig, runtimeEnv } from "./config/resolve";
import type { Env } from "./env";
import { json } from "./http";

// GET /v1/cloud-config: the Claude Code bundle (settings, hooks, VERSION) from the configured private cloud-session-config
// repo, read with the Worker secret GITHUB_CONFIG_PAT (fine-grained, that repo only, Contents read). cloud-setup.sh
// fetches it with the session's bridge token and installs it into ~/.claude, so sessions never hold a GitHub credential.
export const CONFIG_REPO = resolveConfig().cloud.configRepo;
export const GITHUB_API = "https://api.github.com";
const MAX_BYTES = 512 * 1024;

export type CloudConfig = { repo: string; ref: string; commit: string; version: string; files: Record<string, string>; sha256: Record<string, string> };

// A commit's tree never changes, so a bundle is cached by repo and commit sha for the life of the isolate.
const bundles = new Map<string, Omit<CloudConfig, "ref">>();

class ConfigError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function handleCloudConfig(request: Request, url: URL, env: Env): Promise<Response> {
  const config = resolveConfig(env);
  env = runtimeEnv(env);
  const ref = url.searchParams.get("ref") || config.cloud.configRef;
  if (config.cloud.configRefPinned && ref !== config.cloud.configRef) return json({ error: "cloud config ref is pinned by deployment config" }, 400);
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) return json({ error: "ref must be a branch, tag or commit sha" }, 400);
  if (!env.GITHUB_CONFIG_PAT) return json({ error: "GITHUB_CONFIG_PAT is not set on the bridge" }, 503);
  try {
    const repo = env.GITHUB_CONFIG_REPO || CONFIG_REPO;
    if (!repo) return json({ error: "cloud config repository is not configured" }, 503);
    const gh = github(env, repo);
    const commit = (await gh<{ sha: string }>(`/commits/${encodeURIComponent(ref)}`, `no ref ${ref}`)).sha;
    const etag = `"${commit}"`;
    if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    let bundle = bundles.get(`${repo}@${commit}`);
    if (!bundle) {
      bundle = await load(gh, repo, commit);
      bundles.set(`${repo}@${commit}`, bundle);
    }
    return json({ ...bundle, ref } satisfies CloudConfig, 200, { ETag: etag });
  } catch (err) {
    if (err instanceof ConfigError) return json({ error: err.message }, err.status);
    return json({ error: `config repo unreachable: ${err instanceof Error ? err.message : String(err)}` }, 503);
  }
}

type GitHub = <T>(path: string, notFound?: string) => Promise<T>;

function github(env: Env, repo: string): GitHub {
  const base = `${env.GITHUB_CONFIG_API_URL || GITHUB_API}/repos/${repo}`;
  return async (path, notFound) => {
    const res = await fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_CONFIG_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "goonbridge",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 && notFound) throw new ConfigError(404, notFound);
    if (res.status === 401) throw new ConfigError(503, "config repo unreachable: GitHub 401 (GITHUB_CONFIG_PAT expired or revoked?)");
    if (!res.ok) throw new ConfigError(503, `config repo unreachable: GitHub ${res.status}`);
    return res.json();
  };
}

async function load(gh: GitHub, repo: string, commit: string): Promise<Omit<CloudConfig, "ref">> {
  const tree = await gh<{ truncated?: boolean; tree: { path: string; type: string; sha: string; size?: number }[] }>(`/git/trees/${commit}?recursive=1`);
  const blobs = tree.tree.filter((e) => e.type === "blob");
  const total = blobs.reduce((n, e) => n + (e.size ?? 0), 0);
  if (tree.truncated || total > MAX_BYTES) throw new ConfigError(413, `config bundle is over ${MAX_BYTES / 1024} KB; keep only the .claude bundle in the repo`);
  const files: Record<string, string> = {};
  const sha256: Record<string, string> = {};
  for (const e of blobs) {
    const blob = await gh<{ content: string; encoding: string }>(`/git/blobs/${e.sha}`);
    const bytes = blob.encoding === "base64" ? Uint8Array.from(atob(blob.content.replace(/\s/g, "")), (c) => c.charCodeAt(0)) : new TextEncoder().encode(blob.content);
    files[e.path] = new TextDecoder().decode(bytes);
    sha256[e.path] = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return { repo, commit, version: (files.VERSION ?? "").trim(), files, sha256 };
}
