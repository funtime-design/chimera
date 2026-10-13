import { isCloud as cloudName } from "../config/names";
import { appendEvent } from "./events";
import { personOf } from "./roster";
import { BridgeError } from "./validate";

// Device permissions: one table, `device_permissions`, for everything that widens or narrows what one device may do.
// A small fixed set of toggles (PERMISSIONS); no row means the engine default.
//   may_run_full (T-41 trust): per person. The owner of a local device lets another person run it in full mode, so that
//     person's messages to the device run with full permissions instead of read-only. Only "on" is stored; "off" (the
//     default for everyone but the owner) deletes the row. Cloud devices cannot be trusted: shared, ephemeral sandboxes.
//   may_edit_tasks (T-60): off makes the device edit tasks like someone outside its person's household (notes, claims);
//     on lets a cloud device change title and brief, which it never does by default.
//   may_act_as_person: off means the device no longer counts as its person (no owner moves on tasks, no trust changes).
//     It is never turned on for a cloud device: a prompt injected into one must not act for its person.
// Who may set them: may_run_full through bridge_trust / POST /v1/devices/:name/trust is the device's person, as themselves
// or one of their own non-cloud devices (the stamp gate). Any toggle on any device through /docs/settings is an admin
// (config admins), from a non-cloud device. Every change is appended to the events record (subject "device").

export type TrustMode = "full" | "read";
export type TrustResult = { device: string; person: string; mode: TrustMode; changed: boolean };
export type TrustRow = { device: string; person: string; granted_by: string; granted_at: number };
export const PERMISSIONS = ["may_run_full", "may_edit_tasks", "may_act_as_person"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type PermissionValue = "on" | "off" | "default";
export type PermissionRow = { device: string; permission: Permission; person: string | null; allowed: boolean; set_by: string; set_at: number };
// What a caller's device allows beyond the defaults: null is the default.
export type CallerPermissions = { editTasks: boolean | null; actAsPerson: boolean | null };

const isCloud = (name: string) => cloudName(name, true);

// `transaction` wraps the one-time move of the old device_trust rows, so a copy is never half done.
export function initTrust(sql: SqlStorage, transaction: (fn: () => void) => void = (fn) => fn()): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_permissions (
      device TEXT NOT NULL,
      permission TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      allowed INTEGER NOT NULL,
      set_by TEXT NOT NULL,
      set_at INTEGER NOT NULL,
      PRIMARY KEY (device, permission, subject)
    );
  `);
  // A hub from before kept trust in device_trust: its rows become may_run_full rows once, and the old table is renamed
  // (not dropped), so the copy never runs twice and nothing is lost.
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_trust'").toArray().length > 0) {
    transaction(() => {
      sql.exec(`INSERT OR IGNORE INTO device_permissions (device, permission, subject, allowed, set_by, set_at)
        SELECT device, 'may_run_full', person, 1, granted_by, granted_at FROM device_trust`);
      const taken = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_trust_v1'").toArray().length > 0;
      sql.exec(`ALTER TABLE device_trust RENAME TO ${taken ? `device_trust_v1_${Date.now()}` : "device_trust_v1"}`);
    });
  }
}

// The device a permission is read from: a session's child name (cloud or Mac, see hub/devices.ts) reads its parent's.
function deviceOf(sql: SqlStorage, name: string): string {
  return sql.exec<{ parent: string }>("SELECT parent FROM cloud_devices WHERE name = ?", name).toArray()[0]?.parent ?? name;
}

function flag(sql: SqlStorage, device: string, permission: Permission): boolean | null {
  const row = sql.exec<{ allowed: number }>("SELECT allowed FROM device_permissions WHERE device = ? AND permission = ? AND subject = ''", device, permission).toArray()[0];
  return row ? row.allowed === 1 : null;
}

export function callerPermissions(sql: SqlStorage, caller: string): CallerPermissions {
  const device = deviceOf(sql, caller);
  return { editTasks: flag(sql, device, "may_edit_tasks"), actAsPerson: flag(sql, device, "may_act_as_person") };
}

// A device as a target: a member, a device (not a person), and not a session's child name.
function checkDevice(sql: SqlStorage, members: string[], device: string): string {
  if (!members.includes(device)) throw new BridgeError(`unknown device "${device}"`);
  const owner = personOf(device, members);
  if (owner === null) throw new BridgeError(`"${device}" is not a device; permissions are set on one device, not on a person`);
  // A Mac session's child name (alice-laptop-x7k, see hub/devices.ts) is a member while it is live, but it is one session,
  // not a device: the responder answers as the device itself, so a row on the child would never be read.
  const parent = sql.exec<{ parent: string }>("SELECT parent FROM cloud_devices WHERE name = ?", device).toArray()[0]?.parent;
  if (parent) throw new BridgeError(`${device} is a session of ${parent}, not a device; set it on ${parent}`);
  return owner;
}

// may_run_full for one person: the same target rules for the trust API and the settings page.
function writeRunFull(sql: SqlStorage, caller: string, members: string[], device: string, owner: string, person: string, on: boolean): boolean {
  if (isCloud(device)) throw new BridgeError(`${device} is a cloud device; trust applies to local devices`);
  if (!members.includes(person)) throw new BridgeError(`unknown person "${person}"`);
  if (personOf(person, members) !== null) throw new BridgeError(`"${person}" is not a person; trust is given to a person; their devices and cloud sessions stay read-only`);
  if (person === owner) throw new BridgeError(`${person} is the owner of ${device}; the owner already has full mode`);
  const changed = on
    ? sql.exec("INSERT OR IGNORE INTO device_permissions (device, permission, subject, allowed, set_by, set_at) VALUES (?, 'may_run_full', ?, 1, ?, ?)", device, person, caller, Date.now()).rowsWritten > 0
    : sql.exec("DELETE FROM device_permissions WHERE device = ? AND permission = 'may_run_full' AND subject = ?", device, person).rowsWritten > 0;
  if (changed) appendEvent(sql, "device", device, caller, "permission", { permission: "may_run_full", person, value: on ? "on" : "off" });
  return changed;
}

export function setTrust(sql: SqlStorage, caller: string, members: string[], device: string, person: string, mode: TrustMode): TrustResult {
  if (mode !== "full" && mode !== "read") throw new BridgeError(`mode must be "full" or "read", not "${mode}"`);
  // The device first: it decides who the owner is.
  if (!members.includes(device)) throw new BridgeError(`unknown device "${device}"`);
  const owner = personOf(device, members);
  if (owner === null) throw new BridgeError(`"${device}" is not a device; trust is set on one device, not on a person`);
  if (isCloud(device)) throw new BridgeError(`${device} is a cloud device; trust applies to local devices`);
  checkDevice(sql, members, device);
  if ((personOf(caller, members) ?? caller) !== owner) throw new BridgeError(`only ${owner} (the owner) may set trust on ${device}`);
  if (isCloud(caller)) throw new BridgeError(`a cloud session cannot hand out trust; ask ${owner} from a local device`);
  if (callerPermissions(sql, caller).actAsPerson === false) throw new BridgeError(`${caller} may not act as ${owner} (may_act_as_person is off for it); ask ${owner} from another device`);
  const changed = writeRunFull(sql, caller, members, device, owner, person, mode === "full");
  return { device, person, mode, changed };
}

// One toggle on one device, from /docs/settings: admins only, never from a cloud session. `person` names who may_run_full
// is about; "default" (no row) applies to may_edit_tasks and may_act_as_person.
export function setPermission(sql: SqlStorage, caller: string, members: string[], admins: string[], device: string, permission: string, value: string, person = ""): { changed: boolean } {
  if (!(PERMISSIONS as readonly string[]).includes(permission)) throw new BridgeError(`permission must be one of ${PERMISSIONS.join(", ")}, not "${permission}"`);
  if (!["on", "off", "default"].includes(value)) throw new BridgeError(`value must be on, off or default, not "${value}"`);
  if (isCloud(caller)) throw new BridgeError("a cloud session cannot change device permissions; an admin does it from /docs/settings");
  if (!admins.includes(personOf(caller, members) ?? caller) || callerPermissions(sql, caller).actAsPerson === false) {
    throw new BridgeError(`only an admin (${admins.join(", ") || "none configured"}) changes device permissions`);
  }
  const owner = checkDevice(sql, members, device);
  if (permission === "may_run_full") {
    if (value === "default") value = "off";
    return { changed: writeRunFull(sql, caller, members, device, owner, person, value === "on") };
  }
  if (permission === "may_act_as_person" && value === "on" && isCloud(device)) throw new BridgeError(`${device} is a cloud device; a cloud session never acts as its person`);
  const before = flag(sql, device, permission as Permission);
  const after = value === "default" ? null : value === "on";
  if (before === after) return { changed: false };
  if (after === null) sql.exec("DELETE FROM device_permissions WHERE device = ? AND permission = ? AND subject = ''", device, permission);
  else sql.exec("INSERT OR REPLACE INTO device_permissions (device, permission, subject, allowed, set_by, set_at) VALUES (?, ?, '', ?, ?, ?)", device, permission, after ? 1 : 0, caller, Date.now());
  appendEvent(sql, "device", device, caller, "permission", { permission, person: null, value });
  return { changed: true };
}

export function permissionRows(sql: SqlStorage, devices: string[]): PermissionRow[] {
  if (devices.length === 0) return [];
  return sql.exec<{ device: string; permission: Permission; subject: string; allowed: number; set_by: string; set_at: number }>(
    `SELECT * FROM device_permissions WHERE device IN (${devices.map(() => "?").join(", ")}) ORDER BY device, permission, subject`, ...devices,
  ).toArray().map((r) => ({ device: r.device, permission: r.permission, person: r.subject || null, allowed: r.allowed === 1, set_by: r.set_by, set_at: r.set_at }));
}

export function trustedOn(sql: SqlStorage, device: string): string[] {
  return sql.exec<{ subject: string }>("SELECT subject FROM device_permissions WHERE device = ? AND permission = 'may_run_full' AND allowed = 1 ORDER BY subject", device).toArray().map((r) => r.subject);
}

export function trustRows(sql: SqlStorage, devices: string[]): TrustRow[] {
  return permissionRows(sql, devices).filter((r) => r.permission === "may_run_full" && r.allowed)
    .map((r) => ({ device: r.device, person: r.person!, granted_by: r.set_by, granted_at: r.set_at }));
}
