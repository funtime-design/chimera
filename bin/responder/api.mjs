// Calls to the bridge as this device: the API itself, status posts and replies.
import { base } from "./config.mjs";
import { SIGNED_OUT, accessToken, refresh } from "./auth.mjs";
import { clean, log, redact } from "./log.mjs";

const send = async (method, path, body) => fetch(new URL(path, base), {
  method,
  headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// A 401 gets one refresh and one retry (the grant may have been rotated or the token revoked early); a second 401 means the
// grant itself is gone, which only a new login fixes.
export async function api(method, path, body) {
  let res = await send(method, path, body);
  if (res.status === 401) {
    await refresh();
    res = await send(method, path, body);
    if (res.status === 401) throw new Error(SIGNED_OUT);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${data?.error ?? ""}`.trim());
  return data;
}

// Current status, re-posted by the heartbeat so the board shows this device online.
let status = { state: "idle", summary: "waiting for messages" };
export async function postStatus(next) {
  if (next) status = next;
  try {
    await api("POST", "/v1/status", status);
  } catch (err) {
    log(`status failed: ${err.message}`);
  }
}

export async function reply(m, body) {
  try {
    await api("POST", "/v1/send", { thread_id: m.thread_id, to: m.sender, body: redact(clean(body)) });
  } catch (err) {
    log(`message ${m.id}: reply failed, ${err.message}; marking done`);
    // Not swallowed: if done fails too, the caller must not record the message as handled, so it comes back. Tagged, so
    // the caller leaves it for redelivery instead of replacing the undelivered answer with an error reply.
    try {
      await api("POST", "/v1/done", { message_id: m.id });
    } catch (doneErr) {
      doneErr.undelivered = true;
      throw doneErr;
    }
  }
}
