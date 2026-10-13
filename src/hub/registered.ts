import { isCloud } from "../config/names.ts";
import { BridgeError } from "./validate.ts";

// Registered devices: a person's Macs that sign in with the person's own Cloudflare sign-in instead of a static token.
// The device-code sign-in (Task 02) registers one the first time a person picks a new name on the consent page; from
// then on it is a member like any roster device. The name is "<person>-<label>". Names are never reused: a forgotten
// device's name could otherwise be taken over and handed the old device's mail, so a name on the roster, a cloud child's
// name, or an earlier registration is refused.
// Imports keep explicit extensions so Node can import this module in tests by stripping types.

// "cloud" is the static <person>-cloud token, whose sessions become child devices; a registered one must never be mistaken for it.
const LABEL = /^[a-z0-9][a-z0-9-]{0,23}$/;
export function validDeviceLabel(label: string): boolean {
  // "cloud" and "cloud-..." are refused because <person>-cloud is the static cloud token and its children are <person>-cloud-<rand>.
  return LABEL.test(label) && !isCloud(`person-${label}`);
}

// Why `name` cannot be a new device of `person`'s, or null when it can. `taken` is every cloud child and registered name.
export function deviceNameError(name: string, person: string, roster: string[], taken: string[]): string | null {
  const dash = name.indexOf("-");
  // The person part is what personOf would read: everything before the first dash.
  if ((dash < 0 ? name : name.slice(0, dash)) !== person) return `"${name}" is not your device; device names start with "${person}-"`;
  const label = dash < 0 ? "" : name.slice(dash + 1);
  // Shape before "already" (the person's own name is on the roster but has no label), "already" before "cloud" (the
  // person's cloud device is usually on the roster, and "already in use" is the truer refusal there).
  if (!LABEL.test(label)) return `device label must be 1-24 lowercase letters, digits or dashes, starting with a letter or digit: "${name}"`;
  if (roster.includes(name) || taken.includes(name)) return `"${name}" is already a device name; pick another`;
  if (!validDeviceLabel(label)) return `device labels "cloud" and "cloud-..." are reserved for the cloud device: "${name}"`;
  return null;
}

export function initRegistered(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      name TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

// Idempotent for the owner: signing in again as an existing device of yours is not a new registration. Anyone else's
// name, or a name that is or was in use, is refused. The Durable Object runs one call at a time, so two sign-ins racing
// for one name cannot both register it.
export function registerDevice(sql: SqlStorage, person: string, name: string, roster: string[]): { name: string; created: boolean } {
  const error = checkDevice(sql, person, name, roster);
  if (error) throw new BridgeError(error);
  if (sql.exec("SELECT 1 FROM devices WHERE name = ?", name).toArray().length > 0) return { name, created: false };
  sql.exec("INSERT INTO devices (name, person, created_at) VALUES (?, ?, ?)", name, person, Date.now());
  return { name, created: true };
}

// Why `person` may not register `name`, or null when they may (or already have). No side effects: the sign-in checks
// here before the grant exists and registers only after it does, so a failed grant leaves no dead, never-reusable name.
export function checkDevice(sql: SqlStorage, person: string, name: string, roster: string[]): string | null {
  const have = sql.exec<{ person: string }>("SELECT person FROM devices WHERE name = ?", name).toArray()[0];
  if (have) return have.person === person ? null : `"${name}" is not your device`;
  const taken = sql.exec<{ name: string }>("SELECT name FROM cloud_devices WHERE name = ?", name).toArray().map((r) => r.name);
  return deviceNameError(name, person, roster, taken);
}

export function registeredDevices(sql: SqlStorage): { name: string; person: string; created_at: number }[] {
  return sql.exec<{ name: string; person: string; created_at: number }>("SELECT name, person, created_at FROM devices ORDER BY name").toArray();
}

// Drops the device from the roster. Only its own person can register the name again, since the name carries the person.
export function forgetDevice(sql: SqlStorage, name: string): boolean {
  return sql.exec("DELETE FROM devices WHERE name = ?", name).rowsWritten > 0;
}
