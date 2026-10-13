import { bundledConfig, resolveConfig } from "./config/resolve";
import { adminsOf, approversOf } from "./config/schema";
import { isCloud } from "./config/names";
import { deploymentDefaults } from "./deployment";
import { fullRoster, hubOf, parseMembers, rosterOf, type Env } from "./env";
import { groupRoster } from "./board";
import { personOf } from "./hub/roster";
import { PERMISSIONS } from "./hub/trust";
import { versionInfo } from "./version";
import { json } from "./http";

// The admin pages under /docs (pages.ts routes here after the same sign-in as every /docs page):
//   /docs/status   read-only JSON of the setup state the Worker can see (the chimera-setup skill reads it).
//   /docs/settings device-centric admin page: devices per person, per-device permission toggles, connected agents.
// Admins are the people in config `admins` (a bridge role; the task "owner" actor is something else). People, roles and
// every bridge-level value live in deployments/<id>/bridge.config.json and change only by redeploy; nothing here edits them.

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// A browser arrives with the Access cookie, so a form posted from another site would carry it too: refuse cross-site posts.
export function crossSite(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  return (origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== "same-origin" && site !== "none");
}

export async function grantsOf(oauth: NonNullable<Env["OAUTH_PROVIDER"]>, userId: string) {
  const grants = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants.sort((a, b) => b.createdAt - a.createdAt);
}

// The admin `member` acts as, or null. A cloud session may read status, never change settings.
function adminOf(member: string, members: string[], allowCloud: boolean): string | null {
  const person = personOf(member, members) ?? member;
  if (!adminsOf(bundledConfig).includes(person)) return null;
  return !allowCloud && isCloud(member, true) ? null : person;
}
const notAdmin = () => json({ error: `admins only: ${adminsOf(bundledConfig).join(", ") || "no admins are configured"} (config admins)` }, 403);
const noStore = { "Cache-Control": "no-store" };

// People are top-level members with devices or a sign-in email (as the front page counts them); standalone members are not.
function peopleOf(env: Env, members: string[]): { people: string[]; devices: Record<string, string[]> } {
  const { people, devices } = groupRoster(members);
  const signIn = new Set(parseMembers(resolveConfig(env).auth.memberEmails).values());
  return { people: people.filter((p) => (devices[p]?.length ?? 0) > 0 || signIn.has(p)), devices };
}

export async function statusPage(env: Env, member: string): Promise<Response> {
  const members = await fullRoster(env);
  if (!adminOf(member, members, true)) return notAdmin();
  const c = resolveConfig(env);
  const hub = await hubOf(env).setupStatus();
  return json({
    deployment: c.deployment.id,
    version: versionInfo(env.CF_VERSION_METADATA),
    members: peopleOf(env, rosterOf(env)).people.length,
    devices_registered: hub.devices_registered,
    last_contract_check: hub.last_contract_check,
    access: Boolean(c.access.clientId || c.access.pages.audience),
  }, 200, noStore);
}

const LABELS: Record<string, string> = {
  may_run_full: "who besides its person may run it in full mode",
  may_edit_tasks: "off: notes and claims only; on: a cloud session may also change title and brief",
  may_act_as_person: "off: it no longer counts as its person (no owner moves, no trust changes)",
};

export async function settingsPage(_request: Request, env: Env, member: string): Promise<Response> {
  const members = await fullRoster(env);
  if (!adminOf(member, members, false)) return notAdmin();
  const hub = hubOf(env);
  const oauth = env.OAUTH_PROVIDER;
  const c = resolveConfig(env);
  const statics = new Set(rosterOf(env));
  const registered = new Set((await hub.registeredDevices()).map((d) => d.name));
  const { people, devices } = peopleOf(env, members);
  const all = people.flatMap((p) => devices[p] ?? []);
  const rows = await hub.permissionRows(all);
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const select = (name: string, options: string[], current: string) => `<select name="${name}">${options.map((o) => `<option${o === current ? " selected" : ""}>${escapeHtml(o)}</option>`).join("")}</select>`;
  const toggle = (device: string, permission: string) => {
    const row = rows.find((r) => r.device === device && r.permission === permission && r.person === null);
    const current = row ? (row.allowed ? "on" : "off") : "default";
    return `<form method="post" action="/docs/settings">${hidden("action", "permission")}${hidden("device", device)}${hidden("permission", permission)}<label><code>${permission}</code> ${select("value", ["default", "on", "off"], current)}</label> <button>Set</button> <small>${escapeHtml(LABELS[permission])}</small></form>`;
  };
  const runFull = (device: string, person: string) => {
    if (isCloud(device, true)) return `<p><code>may_run_full</code> <small>never on a cloud device</small></p>`;
    const trusted = rows.filter((r) => r.device === device && r.permission === "may_run_full" && r.allowed).map((r) => r.person!);
    const others = people.filter((p) => p !== person);
    return `<form method="post" action="/docs/settings">${hidden("action", "permission")}${hidden("device", device)}${hidden("permission", "may_run_full")}<label><code>may_run_full</code> for ${select("person", others, others[0] ?? "")}</label> ${select("value", ["on", "off"], "on")} <button>Set</button> <small>${trusted.length ? `now: ${escapeHtml(trusted.join(", "))}` : "now: only its person"}; ${escapeHtml(LABELS.may_run_full)}</small></form>`;
  };
  const deviceSections = people.map((person) => {
    const list = (devices[person] ?? []).map((d) => {
      const kind = statics.has(d) ? "token" : registered.has(d) ? "signed in" : "cloud session";
      const forget = registered.has(d) && !statics.has(d) ? `<form method="post" action="/docs/settings">${hidden("action", "forget")}${hidden("name", d)}<button>Forget this device</button></form>` : "";
      return `<li><strong>${escapeHtml(d)}</strong> <small>${kind}</small> ${forget}\n${runFull(d, person)}\n${toggle(d, "may_edit_tasks")}\n${toggle(d, "may_act_as_person")}</li>`;
    });
    return `<section>\n<h3>${escapeHtml(person)}</h3>\n${list.length ? `<ul>\n${list.join("\n")}\n</ul>` : "<p><small>No devices.</small></p>"}\n</section>`;
  });
  const agents: string[] = [];
  if (oauth) {
    const names = new Map<string, string>();
    const clientName = async (id: string) => {
      if (!names.has(id)) names.set(id, (await oauth.lookupClient(id).catch(() => null))?.clientName || id);
      return names.get(id)!;
    };
    for (const name of members) for (const g of await grantsOf(oauth, name)) {
      agents.push(`<li>${escapeHtml(await clientName(g.clientId))} <small>as ${escapeHtml(name)}, signed in ${escapeHtml(new Date(g.createdAt * 1000).toISOString().slice(0, 16).replace("T", " "))} UTC</small></li>`);
    }
  }
  const t = c.timing;
  const facts: [string, string][] = [
    ["Deployment", c.deployment.id], ["Name", c.deployment.displayName], ["Origin", c.deployment.origin], ["Worker", c.cloudflare.workerName],
    ["Admins", adminsOf(c).join(", ") || "none"], ["Approvers", approversOf(c).join(", ") || "none"], ["People", people.join(", ")],
    ["Timings (s)", `claim ${t.claimSeconds}, lease ${t.claimLeaseSeconds}, boot ${t.bootSeconds}, online ${t.onlineSeconds}, status expiry ${t.statusExpirySeconds}, deploy ${t.deploySeconds}`],
    ["Labels", [c.labels.ciRed, c.labels.branchGone, c.labels.deployFailed, c.labels.reReview, c.labels.revert, ...c.labels.exempt].join(", ")],
  ];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(deploymentDefaults.name)} settings</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}h2{font-size:1.2rem;margin:2rem 0 .5rem}h3{font-size:1.05rem;margin:1rem 0 .25rem}ul{padding-left:1.2rem}li{margin:.5rem 0}small{color:#666}form{margin:.15rem 0}dt{font-weight:600}dd{margin:0 0 .4rem}</style>
</head><body>
<h1>${escapeHtml(deploymentDefaults.name)} settings</h1>
<p><small>As ${escapeHtml(member)} (admin). Device permissions are recorded as events.</small></p>
<h2>Devices</h2>
<p><small>To add a device, run <code>${escapeHtml(deploymentDefaults.responderCommand)} login</code> on it and pick its name (device sign-in). Forget removes a signed-in device and every sign-in it holds; the name is never reused. Token devices are set in config.</small></p>
${deviceSections.join("\n")}
<h2>Connected agents</h2>
${agents.length ? `<ul>\n${agents.join("\n")}\n</ul>` : "<p><small>No sign-ins.</small></p>"}
<p><small>Each person revokes their own sign-ins on <a href="/docs/devices">their devices page</a>.</small></p>
<h2>Bridge (read-only)</h2>
<dl>
${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("\n")}
</dl>
<p><small>People, admins and every value above are edited in <code>deployments/${escapeHtml(c.deployment.id)}/bridge.config.json</code> (emails and tokens in its ignored <code>secrets.json</code>), then redeployed. A new member must also be in the Cloudflare Access group when Access guards the bridge.</small></p>
<p><a href="/docs">Back to ${escapeHtml(deploymentDefaults.name)}</a></p>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...noStore, "Content-Security-Policy": PAGE_CSP } });
}

export async function settingsAction(request: Request, env: Env, member: string): Promise<Response> {
  if (crossSite(request)) return json({ error: "cross-site form posts are refused" }, 403);
  const members = await fullRoster(env);
  if (!adminOf(member, members, false)) return notAdmin();
  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? "").trim().toLowerCase();
  const hub = hubOf(env);
  const action = field("action");
  if (action === "permission") {
    await hub.setPermission(member, members, adminsOf(bundledConfig), field("device"), field("permission"), field("value"), field("person") || undefined);
  } else if (action === "forget") {
    const name = field("name");
    if (!(await hub.registeredDevices()).some((d) => d.name === name) || rosterOf(env).includes(name)) return json({ error: `not a signed-in device: ${name}` }, 400);
    // Off the roster first, so its grants stop standing at once, then the grants themselves.
    await hub.forgetDevice(name);
    if (env.OAUTH_PROVIDER) for (const g of await grantsOf(env.OAUTH_PROVIDER, name)) await env.OAUTH_PROVIDER.revokeGrant(g.id, name);
  } else {
    return json({ error: `action must be permission or forget; permissions: ${PERMISSIONS.join(", ")}` }, 400);
  }
  return new Response(null, { status: 303, headers: { Location: "/docs/settings", ...noStore } });
}
