import { OTHER, OTHER_CLOUD, OWNER, OWNER_CLOUD, OWNER_DEVICE } from "./harness/roles.mjs";
// The real Hub (src/hub.ts) against an in-memory SQLite, for unit tests of races and timings the HTTP tests cannot hold
// open. As bookkeeping.test.mjs does for one module: bundled with esbuild, the Durable Object base class stubbed.
import { build } from "esbuild";
import { NEUTRAL, ACTIVE_CONFIG } from "./harness/roles.mjs";
import { configPlugin } from "./harness/build.mjs";

const sqlite = process.getBuiltinModule?.("node:sqlite");
export const noSqlite = !sqlite && "node:sqlite is not available";

const loaded = new Map();
// Any src module, bundled with its imports (cloudflare:workers stubbed).
export async function loadModule(rel) {
  if (loaded.has(rel)) return loaded.get(rel);
  const { outputFiles } = await build({
    entryPoints: [new URL(`../${rel}`, import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node",
    plugins: [...(NEUTRAL ? [configPlugin(ACTIVE_CONFIG)] : []), { name: "cloudflare-workers", setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cf", namespace: "cf" }));
      b.onLoad({ filter: /.*/, namespace: "cf" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
    } }],
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
  loaded.set(rel, mod);
  return mod;
}
export const hubModuleLoaded = () => loadModule("src/hub.ts");

// SqlStorage over node:sqlite: exec returns a cursor with toArray, one, rowsWritten and iteration.
export function memorySql() {
  const db = new sqlite.DatabaseSync(":memory:");
  const cursor = (rows, written = 0) => ({ toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`); return rows[0]; }, rowsWritten: written, [Symbol.iterator]: () => rows[Symbol.iterator]() });
  return {
    db,
    exec(q, ...p) {
      if (p.length === 0 && /;\s*\S/.test(q.trim())) { db.exec(q); return cursor([]); }
      const stmt = db.prepare(q);
      if (stmt.columns().length > 0) return cursor(stmt.all(...p));
      return cursor([], Number(stmt.run(...p).changes));
    },
  };
}

// A Hub with short windows (seconds), its alarm recorded instead of scheduled.
export async function memoryHub(env = {}) {
  const { Hub } = await hubModuleLoaded();
  const sql = memorySql();
  let alarm = null;
  const ctx = {
    storage: {
      sql,
      transactionSync: (fn) => { sql.db.exec("SAVEPOINT t"); try { const r = fn(); sql.db.exec("RELEASE t"); return r; } catch (e) { sql.db.exec("ROLLBACK TO t"); sql.db.exec("RELEASE t"); throw e; } },
      getAlarm: async () => alarm,
      setAlarm: async (t) => { alarm = t; },
      deleteAlarm: async () => { alarm = null; },
    },
  };
  const hub = new Hub(ctx, { GOONBRIDGE_CLAIM_SECONDS: "3", GOONBRIDGE_CLAIM_LEASE_SECONDS: "1", GOONBRIDGE_BOOT_SECONDS: "1", GOONBRIDGE_DEPLOY_SECONDS: "3", ...env });
  // As a Durable Object stub: every method call answers with a promise (RPC), whether the method is sync or not.
  const stub = new Proxy(hub, { get: (t, k) => (typeof t[k] === "function" ? (...a) => Promise.resolve().then(() => t[k](...a)) : t[k]) });
  return {
    hub: stub, raw: hub, sql,
    alarmAt: () => alarm,
    // Runs the alarm the way the runtime would: clears it, then calls alarm().
    fireAlarm: async () => { alarm = null; await hub.alarm(); },
  };
}

export const MEMBERS = [OWNER, OWNER_DEVICE, OWNER_CLOUD, OTHER, OTHER_CLOUD];
export const ROSTER = MEMBERS;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
