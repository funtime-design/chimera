// An in-memory Cloudflare Access API for access:provision and setup tests (not a test file itself). Error bodies echo
// the presented credential, the account and `leak` values, so a printed body shows up as a leak.
import { randomBytes } from 'node:crypto';

export function accessFake({ token, account, clientSecret, teamDomain = 'acme-team.cloudflareaccess.com', enabled = true, fail, state: given, leak = [], fallback } = {}) {
  const state = given ?? { idps: [], groups: [], policies: [], apps: [], n: 0 };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'api.cloudflare.com' && fallback) return fallback(url, init);
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    if (fail === 'throw') throw new Error(`network down ${token} ${account}`);
    const auth = new Headers(init.headers).get('Authorization');
    const bad = status => Response.json({ success: false, errors: [{ message: `bad ${auth} ${account} ${clientSecret} ${leak.join(' ')}` }] }, { status });
    if (auth !== `Bearer ${token}` || fail === 'forbidden') return bad(403);
    const prefix = `/client/v4/accounts/${account}/access`;
    if (!u.pathname.startsWith(prefix)) return bad(404);
    const p = u.pathname.slice(prefix.length);
    const ok = result => Response.json({ success: true, result, result_info: Array.isArray(result) ? { page: 1, total_pages: 1 } : undefined });
    const id = kind => `${kind}-${++state.n}`;
    if (p === '/organizations' && method === 'GET') return enabled ? ok({ auth_domain: teamDomain, name: 'acme-team' }) : Response.json({ success: false, errors: [{ code: 12130, message: 'access.api.error.not_enabled' }] }, { status: 404 });
    for (const [route, list, kind] of [['/identity_providers', state.idps, 'idp'], ['/groups', state.groups, 'grp'], ['/policies', state.policies, 'pol']]) {
      if (p !== route) continue;
      if (method === 'GET') return ok(list);
      const item = { id: id(kind), ...body }; list.push(item); return ok(item);
    }
    if (p.startsWith('/groups/') && method === 'PUT') {
      const g = state.groups.find(x => x.id === decodeURIComponent(p.slice(8)));
      if (!g || fail === 'put') return bad(500);
      Object.assign(g, body); return ok(g);
    }
    if (p === '/apps') {
      if (method === 'GET') return ok(state.apps.map(a => ({ ...a, saas_app: { ...a.saas_app, client_secret: undefined } })));
      if (fail === 'app') return bad(500);
      const app = { id: id('app'), ...body, policies: body.policies.map(pid => ({ id: pid })), saas_app: { ...body.saas_app, client_id: `cid${randomBytes(8).toString('hex')}`, client_secret: clientSecret } };
      state.apps.push(app); return ok(app);
    }
    return bad(404);
  };
  return { fetchImpl, calls, state };
}
