import type { Hub, Message } from "./hub";
import { MAX_WAIT_SECONDS } from "./hub/settings";

// A long-poll waits here in the Worker, not inside the Durable Object: every object call returns at once, so the
// object goes idle between calls and picks up new code on the next deploy. With the wait inside the object, two or
// three responders polling back to back kept it busy for hours and it ran old code through every deploy.
const POLL_MS = 1500;

export async function inboxWait(hub: DurableObjectStub<Hub>, member: string, members: string[], waitSeconds: number, peek: boolean): Promise<{ messages: Message[]; more: number }> {
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  for (;;) {
    const got = await hub.inbox(member, members, 0, peek);
    if (got.messages.length > 0 || Date.now() >= deadline) return got;
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(deadline - Date.now(), 0))));
  }
}
