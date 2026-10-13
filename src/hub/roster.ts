import { BridgeError } from "./validate";

// A device is "<person>-<device>" where <person> is itself a member, e.g. alice-laptop under alice.
export function personOf(name: string, members: string[]): string | null {
  const dash = name.indexOf("-");
  if (dash <= 0) return null;
  const person = name.slice(0, dash);
  return members.includes(person) ? person : null;
}

// "all" reaches the people and standalone members (pipelines), not devices: a device only gets what is sent to it by name.
export function receivesAll(member: string, members: string[]): boolean {
  return personOf(member, members) === null;
}

export function people(members: string[]): string[] {
  return members.filter((m) => personOf(m, members) === null);
}

// A person and their devices are one household.
export function household(member: string, members: string[]): string[] {
  const person = personOf(member, members) ?? member;
  return members.filter((m) => m === person || personOf(m, members) === person);
}

export function memberFor(name: string, members: string[], what: string): string {
  const n = name.trim().toLowerCase();
  if (!members.includes(n)) throw new BridgeError(`unknown ${what} "${name}"; members: ${members.join(", ")}`);
  return n;
}

// An owner is a person; naming one of their devices means the person.
export function personFor(name: string, members: string[]): string {
  const n = memberFor(name, members, "owner");
  return personOf(n, members) ?? n;
}
