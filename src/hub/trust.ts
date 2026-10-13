import { isCloud as cloudName } from "../config/names";
import { personOf } from "./roster";
import { BridgeError } from "./validate";

// Device trust (T-41): the owner of a local device can let another person run it in full mode, so that person's
// messages to the device run with full permissions instead of read-only. Trust is per device and per person. Only
// "full" is stored; "read" (the default for everyone but the owner) deletes the row, so there is no middle mode.
// Who may set it is the stamp gate: the device's person, as themselves or one of their own non-cloud devices. A cloud
// session may not, because a prompt injected into one must not be able to open the owner's Mac to someone else.
// Cloud devices (<person>-cloud and its children) cannot be trusted at all: they are shared, ephemeral sandboxes.

export type TrustMode = "full" | "read";
export type TrustResult = { device: string; person: string; mode: TrustMode; changed: boolean };
export type TrustRow = { device: string; person: string; granted_by: string; granted_at: number };

const isCloud = (name: string) => cloudName(name, true);

export function initTrust(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_trust (
      device TEXT NOT NULL,
      person TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (device, person)
    );
  `);
}

export function setTrust(sql: SqlStorage, caller: string, members: string[], device: string, person: string, mode: TrustMode): TrustResult {
  if (mode !== "full" && mode !== "read") throw new BridgeError(`mode must be "full" or "read", not "${mode}"`);
  // The device first: it decides who the owner is.
  if (!members.includes(device)) throw new BridgeError(`unknown device "${device}"`);
  const owner = personOf(device, members);
  if (owner === null) throw new BridgeError(`"${device}" is not a device; trust is set on one device, not on a person`);
  if (isCloud(device)) throw new BridgeError(`${device} is a cloud device; trust applies to local devices`);
  // A Mac session's child name (alice-laptop-x7k, see hub/devices.ts) is a member while it is live, but it is one session,
  // not a device: the responder answers as the device itself, so a row on the child would never be read.
  const parent = sql.exec<{ parent: string }>("SELECT parent FROM cloud_devices WHERE name = ?", device).toArray()[0]?.parent;
  if (parent) throw new BridgeError(`${device} is a session of ${parent}, not a device; set trust on ${parent}`);
  if ((personOf(caller, members) ?? caller) !== owner) throw new BridgeError(`only ${owner} (the owner) may set trust on ${device}`);
  if (isCloud(caller)) throw new BridgeError(`a cloud session cannot hand out trust; ask ${owner} from a local device`);
  if (!members.includes(person)) throw new BridgeError(`unknown person "${person}"`);
  if (personOf(person, members) !== null) throw new BridgeError(`"${person}" is not a person; trust is given to a person; their devices and cloud sessions stay read-only`);
  if (person === owner) throw new BridgeError(`${person} is the owner of ${device}; the owner already has full mode`);
  const changed = mode === "full"
    ? sql.exec("INSERT OR IGNORE INTO device_trust (device, person, granted_by, granted_at) VALUES (?, ?, ?, ?)", device, person, caller, Date.now()).rowsWritten > 0
    : sql.exec("DELETE FROM device_trust WHERE device = ? AND person = ?", device, person).rowsWritten > 0;
  return { device, person, mode, changed };
}

export function trustedOn(sql: SqlStorage, device: string): string[] {
  return sql.exec<{ person: string }>("SELECT person FROM device_trust WHERE device = ? ORDER BY person", device).toArray().map((r) => r.person);
}

export function trustRows(sql: SqlStorage, devices: string[]): TrustRow[] {
  if (devices.length === 0) return [];
  return sql.exec<TrustRow>(`SELECT device, person, granted_by, granted_at FROM device_trust WHERE device IN (${devices.map(() => "?").join(", ")}) ORDER BY device, person`, ...devices).toArray();
}
