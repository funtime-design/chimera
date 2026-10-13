import { clientScript } from "./config/client";
import { renderGuide } from "./rules";
import { deploymentDefaults } from "./deployment";
import { claimSeconds, onlineSeconds, statusExpirySeconds, type Hub, type TaskSummary } from "./hub";
import { homePage } from "./home";
import { fullRoster, hubOf, parseMembers, parseTokens, rosterOf, type Env } from "./env";
import { board, boardTimes, groupRoster } from "./board";
import { accessMember, authenticate, oauthMember } from "./auth";
import { identify } from "./devices";
import { household } from "./hub/roster";
import { SERVER_INFO, TOOLS } from "./tools";
import { byOwner } from "./text";
import { json, withBridge } from "./http";
import SETUP_GUIDE from "../docs/agent-setup.md";
import CONNECTOR from "../bin/goonbridge-mcp.mjs";
import CLOUD_SETUP from "../bin/cloud-setup.sh";
import RESPONDER from "../bin/goonbridge-responder.mjs";
import RESPONDER_INSTALL from "../bin/install-responder-macos.sh";

// Served without a token: the stdio connector, the cloud-environment setup script (no secrets in it;
// the environment's setup box holds one line: curl -fsSL <origin>/cloud-setup.sh | bash), and the Mac responder with its
// launchd installer (the grant comes from `goonbridge-responder login`, never from these files).
const JS = "text/javascript; charset=utf-8";
const SH = "text/plain; charset=utf-8";
export function staticFile(path: string, _origin: string): { body: string; type: string } | undefined {
  if (path === deploymentDefaults.connectorAsset) path = "/goonbridge-mcp.mjs";
  if (path === deploymentDefaults.responderAsset) path = "/goonbridge-responder.mjs";
  switch (path) {
    case "/goonbridge-mcp.mjs": return { body: CONNECTOR, type: JS };
    case "/cloud-setup.sh": return { body: clientScript(CLOUD_SETUP), type: SH };
    case "/goonbridge-responder.mjs": return { body: RESPONDER, type: JS };
    case "/install-responder-macos.sh": return { body: clientScript(RESPONDER_INSTALL), type: SH };
    default: return undefined;
  }
}

// /docs, /docs/setup.md and /docs/tasks: the front page, the guide and the backlogs. Cloudflare Access guards the prefix
// in front of the Worker, so a browser arrives with an Access JWT; agents use a bearer token instead. Nothing here is
// served to a request that carries neither, even if the Access app were missing.
export async function pagesEndpoint(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // The one form on these pages is /docs/devices (revoke a grant, forget a device); everything else is read-only.
  const postable = url.pathname === "/docs/devices";
  if (request.method !== "GET" && !(postable && request.method === "POST")) return json({ error: "method not allowed" }, 405, { Allow: postable ? "GET, POST" : "GET" });
  const member = (await authenticate(request, parseTokens(env.GOONBRIDGE_TOKENS))) ?? (await oauthMember(request, env, url.origin, await fullRoster(env))) ?? (await accessMember(request, env));
  if (!member) return signInPage();
  switch (url.pathname) {
    case "/docs":
    case "/docs/": return frontPage(env, url.origin);
    case "/docs/setup.md": return new Response(setupGuide(url.origin), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
    case "/docs/tasks": return withBridge(env, async () => tasksPage(url, hubOf(env), member, await fullRoster(env)));
    case "/docs/devices": return withBridge(env, async () => request.method === "POST" ? devicesAction(request, env, member) : devicesPage(request, env, member));
    default: return json({ error: "not found" }, 404);
  }
}


// /docs/devices: the signed-in person's household (static devices, registered devices, live cloud children) with online
// flags and the OAuth grants behind each, newest first. Only that household is listed and only its grants can be revoked;
// revokeGrant is keyed by user id as well, so a grant id from elsewhere cannot reach another person's grant.
async function myDevices(request: Request, env: Env, member: string) {
  const { members } = await identify(request, env, member);
  const registered = new Set((await hubOf(env).registeredDevices()).map((d) => d.name));
  return { members, mine: household(member, members), registered };
}

async function grantsOf(oauth: NonNullable<Env["OAUTH_PROVIDER"]>, userId: string) {
  const grants = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants.sort((a, b) => b.createdAt - a.createdAt);
}

async function devicesPage(request: Request, env: Env, member: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER!;
  const { members, mine, registered } = await myDevices(request, env, member);
  const online = new Set(board(members, await hubOf(env).statuses(), boardTimes(env)).filter((e) => e.online).map((e) => e.member));
  const statics = new Set(rosterOf(env));
  const clients = new Map<string, string>();
  const clientName = async (id: string) => {
    if (!clients.has(id)) clients.set(id, (await oauth.lookupClient(id).catch(() => null))?.clientName || id);
    return clients.get(id)!;
  };
  // Device trust (T-41): who besides the owner may run each device in full mode. Set with bridge_trust or POST /v1/devices/:name/trust.
  const trusted = new Map<string, string[]>();
  for (const r of await hubOf(env).trustRows(mine)) trusted.set(r.device, [...(trusted.get(r.device) ?? []), r.person]);
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const rows = await Promise.all(mine.map(async (name) => {
    const grants = await grantsOf(oauth, name);
    const items = await Promise.all(grants.map(async (g) => `<li>${escapeHtml(await clientName(g.clientId))} <small>signed in ${escapeHtml(new Date(g.createdAt * 1000).toISOString().slice(0, 16).replace("T", " "))} UTC</small>
<form method="post" action="/docs/devices">${hidden("action", "revoke")}${hidden("grant_id", g.id)}${hidden("user_id", name)}<button>Revoke</button></form></li>`));
    const kind = statics.has(name) ? "token" : registered.has(name) ? "signed in" : "cloud session";
    const forget = registered.has(name) && !statics.has(name)
      ? `\n<form method="post" action="/docs/devices">${hidden("action", "forget")}${hidden("name", name)}<button>Forget this device</button></form>` : "";
    return `<section>
<h2>${escapeHtml(name)} <small>${online.has(name) ? "online" : "offline"} · ${kind}</small></h2>
${trusted.has(name) ? `<p>full mode for: ${escapeHtml(trusted.get(name)!.join(", "))}</p>\n` : ""}${items.length ? `<ul>\n${items.join("\n")}\n</ul>` : "<p><small>No sign-ins.</small></p>"}${forget}
</section>`;
  }));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(deploymentDefaults.name)} devices</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}h2{font-size:1.1rem;margin:1.5rem 0 .25rem}ul{padding-left:1.2rem}small{color:#666}form{display:inline;margin-left:.5rem}</style>
</head><body>
<h1>Your devices</h1>
<p><small>As ${escapeHtml(member)}. Revoke ends one sign-in (its tokens stop working). Forget removes a signed-in device and every sign-in it holds; the name is never reused.</small></p>
${rows.join("\n")}
<p><a href="/docs">Back to ${escapeHtml(deploymentDefaults.name)}</a></p>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PAGE_CSP } });
}

async function devicesAction(request: Request, env: Env, member: string): Promise<Response> {
  // A browser arrives with the Access cookie, so a form posted from another site would carry it too: refuse cross-site posts.
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== "same-origin" && site !== "none")) {
    return json({ error: "cross-site form posts are refused" }, 403);
  }
  const oauth = env.OAUTH_PROVIDER!;
  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? "");
  const { mine, registered } = await myDevices(request, env, member);
  const action = field("action");
  if (action === "revoke") {
    const userId = field("user_id");
    if (!mine.includes(userId) || !field("grant_id")) return json({ error: `not one of your devices: ${userId}` }, 403);
    await oauth.revokeGrant(field("grant_id"), userId);
  } else if (action === "forget") {
    const name = field("name");
    if (!mine.includes(name) || !registered.has(name) || rosterOf(env).includes(name)) return json({ error: `not a signed-in device of yours: ${name}` }, 403);
    // Off the roster first, so its grants stop standing at once, then the grants themselves.
    await hubOf(env).forgetDevice(name);
    for (const g of await grantsOf(oauth, name)) await oauth.revokeGrant(g.id, name);
  } else {
    return json({ error: "action must be revoke or forget" }, 400);
  }
  return new Response(null, { status: 303, headers: { Location: "/docs/devices", "Cache-Control": "no-store" } });
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

function signInPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(deploymentDefaults.name)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style></head>
<body><h1>${escapeHtml(deploymentDefaults.name)}</h1><p>This page is for members. Sign in with Cloudflare Access, or send a bearer token.</p></body></html>`;
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "WWW-Authenticate": "Bearer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
}

// Plain HTML for a phone browser: every person's open tasks, grouped by owner and then state. ?state=all shows closed ones too.
async function tasksPage(url: URL, hub: DurableObjectStub<Hub>, member: string, members: string[]): Promise<Response> {
  const states = url.searchParams.getAll("state").flatMap((v) => v.split(",")).filter(Boolean);
  const tasks = await hub.taskList(member, members, { scope: "all", states, limit: 200 });
  const sections = [...byOwner(tasks, groupRoster(members).people)].map(([owner, list]) => {
    const byState = new Map<string, TaskSummary[]>();
    for (const t of list) byState.set(t.state, [...(byState.get(t.state) ?? []), t]);
    const body = list.length
      ? [...byState].map(([state, items]) => `<h3>${escapeHtml(state)} (${items.length})</h3>\n<ul>\n${items.map(taskItem).join("\n")}\n</ul>`).join("\n")
      : "<p>No open tasks.</p>";
    return `<section>\n<h2>${escapeHtml(owner)} (${list.length})</h2>\n${body}\n</section>`;
  });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(deploymentDefaults.name)} tasks</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}h3{font-size:1rem;margin:1rem 0 .25rem}ul{padding-left:1.2rem}small{color:#666}</style>
</head><body>
<h1>Tasks</h1>
<p><small>As ${escapeHtml(member)}, ${escapeHtml(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC.</small></p>
${sections.join("\n")}
</body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

// No token: member names and online flags only. People are top-level members with devices or a sign-in email;
// the rest are standalone members (pipelines, agents).
async function frontPage(env: Env, origin: string): Promise<Response> {
  // Registered devices (device sign-in) are members like the static ones, so they are listed too.
  const members = await fullRoster(env);
  const { people, devices } = groupRoster(members);
  const online = new Set(board(members, await hubOf(env).statuses(), boardTimes(env)).filter((e) => e.online).map((e) => e.member));
  const signIn = new Set(parseMembers(env.GOONBRIDGE_MEMBERS).values());
  const entry = (name: string) => ({ name, online: online.has(name) });
  const isPerson = (p: string) => (devices[p]?.length ?? 0) > 0 || signIn.has(p);
  const uploaded = env.CF_VERSION_METADATA?.timestamp ? new Date(env.CF_VERSION_METADATA.timestamp) : null;
  const html = homePage({
    origin,
    version: SERVER_INFO.version,
    deployed: uploaded && !Number.isNaN(uploaded.getTime()) ? uploaded.toISOString().slice(0, 10) : null,
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    people: people.filter(isPerson).map((p) => ({ ...entry(p), devices: (devices[p] ?? []).map(entry) })),
    standalone: people.filter((p) => !isPerson(p)).map(entry),
    claimSeconds: claimSeconds(env),
    onlineSeconds: onlineSeconds(env),
    expirySeconds: statusExpirySeconds(env),
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

function taskItem(t: TaskSummary): string {
  const bits = [
    `P${t.priority}`,
    t.assignee ? `-> ${escapeHtml(t.assignee)}` : "",
    escapeHtml([t.repo, t.branch].filter(Boolean).join(" @ ")),
    t.due ? `due ${escapeHtml(t.due)}` : "",
    t.labels.map((l) => `#${escapeHtml(l)}`).join(" "),
    t.pr_url ? `<a href="${escapeHtml(t.pr_url)}">PR</a>` : "",
  ].filter(Boolean);
  return `<li><strong>${escapeHtml(t.key)}</strong> ${escapeHtml(t.title)} <small>${bits.join(" · ")}</small></li>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function setupGuide(origin: string): string {
  return renderGuide(SETUP_GUIDE, deploymentDefaults, origin);
}
