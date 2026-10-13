import { deploymentDefaults } from "./deployment";
import { runtimeEnv } from "./config/resolve";
import { Hub } from "./hub";
import { parseTokens, type Env } from "./env";
import { providerFor } from "./provider";
import { staticFile } from "./pages";
import { json } from "./http";
import { githubWebhook } from "./github";

export { Hub };
export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env = runtimeEnv(env);
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    // The pages live under /docs, the one prefix Cloudflare Access guards; the old paths send you there.
    if (request.method === "GET" && url.pathname === "/") return Response.redirect(`${url.origin}/docs`, 302);
    if (request.method === "GET" && url.pathname === "/setup.md") return Response.redirect(`${url.origin}/docs/setup.md`, 308);
    if (request.method === "GET" && url.pathname === "/tasks") return Response.redirect(`${url.origin}/docs/tasks${url.search}`, 308);
    const file = request.method === "GET" ? staticFile(url.pathname, url.origin) : undefined;
    if (file) return new Response(file.body, { headers: { "Content-Type": file.type } });
    // GitHub signs its own deliveries and cannot send a bearer, so the webhook is answered before authentication.
    if (url.pathname === "/v1/github/webhook") return githubWebhook(request, env);
    if (!parseTokens(env.GOONBRIDGE_TOKENS)) return json({ error: `server misconfigured: ${deploymentDefaults.envPrefix}_TOKENS is not set` }, 500);
    return providerFor(url.origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
