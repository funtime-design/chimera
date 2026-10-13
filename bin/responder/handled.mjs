// Which messages need no work: ones already handled, a device's or session child's reply in a thread this responder never
// answered in, and a device's reply to this responder's own answer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.mjs";
import { api } from "./api.mjs";

const mark = (dir, name, text = new Date().toISOString()) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, String(name)), text, { mode: 0o600 });
};

// A message is handled once: a marker per id survives restarts and claim expiry, so a redelivered message is only marked
// done. The marker is written only after the work and the reply are finished, so a crash in between leaves the message
// to be redelivered and done again (at least once).
const handledDir = join(stateDir, "handled");
export const markHandled = (id) => mark(handledDir, id);
export const wasHandled = (id) => existsSync(join(handledDir, String(id)));

// The threads this responder answered in, marked before the reply is sent: a crash between the two costs at most an extra
// answer later, never a thread wrongly taken for someone else's. Other clients of the same device (interactive windows)
// send under the same name, so the sender alone cannot tell whose a thread is.
const threadsDir = join(stateDir, "threads");
export const markThread = (threadId) => mark(threadsDir, threadId);
const answeredIn = (threadId) => existsSync(join(threadsDir, String(threadId)));

// Threads from before the markers existed: a message this device sent before .since counts as this responder's.
const sinceFile = join(threadsDir, ".since");
export const ensureSince = () => { if (!existsSync(sinceFile)) mark(threadsDir, ".since"); };
const since = () => { try { return readFileSync(sinceFile, "utf8").trim(); } catch { return ""; } };

// What to do with a message: "answer" it, or skip it as "not-mine" (a device or session child replying in a thread this
// responder never answered in; another client of this device is having that conversation) or "reply-to-me" (a device's
// answer to this responder's own answer, which gets none, so two responders cannot loop). A person is always answered:
// a reply from the owner's phone is never dropped, whoever wrote in the thread before.
export async function triage(me, self, m) {
  if (m.id === m.thread_id) return "answer";
  const thread = await api("GET", `/v1/threads/${m.thread_id}`);
  const before = thread.filter((x) => x.id < m.id);
  const cutoff = since();
  const mine = answeredIn(m.thread_id) || before.some((x) => x.sender === me && cutoff && x.created_at < cutoff);
  const person = (self.members ?? []).includes(m.sender);
  if (!mine && !person) return "not-mine";
  const devices = Object.values(self.devices ?? {}).flat();
  if (mine && devices.includes(m.sender) && before[before.length - 1]?.sender === me) return "reply-to-me";
  return "answer";
}
