// These byte fixtures were captured from ad3af5f BEFORE the extraction; never regenerate from rules.ts. They are an
// owner deployment's baseline in .private/fixtures/<id>/ and run only when that deployment is bundled (owner mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadModule } from './hub-memory.mjs';
import { bundledBaseline, readDeployment, brandingPattern } from './harness/baselines.mjs';
const baseline = bundledBaseline('rules.json'), guideBaseline = bundledBaseline('agent-setup-before-rules.md');
const fixture = baseline.url ? JSON.parse(readFileSync(baseline.url, 'utf8')) : null;
const owner = { skip: baseline.skip };
const rulesUrl = new URL('../src/rules.ts', import.meta.url);

test('all agent-facing outputs retain the pre-extraction bytes', owner, async () => {
  assert.ok(existsSync(rulesUrl), 'the canonical rules module must exist');
  const r = await loadModule('src/rules.ts');
  const { deploymentDefaults: c } = await loadModule('src/deployment.ts');
  const { renderCases } = await import('./rules-cases.mjs');
  const got = renderCases(r, c);
  for (const key of Object.keys(got)) assert.deepEqual(got[key], fixture[key], key);
  const tools = await loadModule('src/tools.ts');
  assert.equal(tools.INSTRUCTIONS, fixture.instructions);
  assert.deepEqual(tools.TOOLS, fixture.tools);
});

test('every rules output accepts an entirely neutral deployment identity', async () => {
  assert.ok(existsSync(rulesUrl), 'the canonical rules module must exist');
  const r = await loadModule('src/rules.ts');
  const { deploymentDefaults } = await loadModule('src/deployment.ts');
  const { renderCases, neutralIdentity } = await import('./rules-cases.mjs');
  const c = { ...deploymentDefaults, ...neutralIdentity };
  const template = '{{BASE_URL}}\n' + Object.keys(r.buildGuideRules(c)).map(key => `{{RULES.${key}}}`).join('\n\n');
  assert.doesNotMatch(JSON.stringify([renderCases(r, c), r.renderGuide(template, c, c.baseUrl)]), brandingPattern());
});

test('routine and reviewer notices retain the original bytes, including missing session ids', owner, async () => {
  const r = await loadModule('src/rules.ts');
  assert.equal(typeof r.buildCloudNotice, 'function');
  const notices = {
    cloud: id => r.buildCloudNotice('alice-cloud', 'https://example.com/session', id),
    routine: id => r.buildRoutineNotice('example', 'https://example.com/session', id),
    result: id => r.buildRoutineResult('example', 'https://example.com/session', id),
    review: id => r.buildReviewNotice(9, 'https://example.com/session', id),
    warning: () => r.buildReviewWarning('bookkeeping failed'),
  };
  for (const [key, fn] of Object.entries(notices)) {
    const rendered = ['session9', ''].map(fn);
    assert.deepEqual(rendered, fixture.notices[key], key);
    assert.doesNotMatch(JSON.stringify(rendered), brandingPattern());
  }
});

test('served guide expands every canonical block and preserves the complete original guide', { skip: baseline.skip || guideBaseline.skip }, async () => {
  const { loadSurfaces } = await import('./rules-surfaces.mjs');
  const { setupGuide } = await loadSurfaces();
  const original = readFileSync(guideBaseline.url, 'utf8');
  for (const origin of [readDeployment(guideBaseline.id).deployment.origin, 'https://example.com']) {
    const served = setupGuide(origin);
    assert.equal(served, original.replaceAll('{{BASE_URL}}', origin));
    assert.doesNotMatch(served, /\{\{(?:RULES\.|BASE_URL)/);
    for (const sentence of Object.values(fixture.guide)) assert.ok(served.includes(sentence));
  }
});

test('actual MCP initialization, tool list, member help and guide use the canonical renderers', owner, async () => {
  const { loadSurfaces } = await import('./rules-surfaces.mjs');
  const { handleMcp, setupGuide } = await loadSurfaces();
  const hub = { statuses: async () => [{ member: 'alice-laptop', seen_at: Date.now() }] };
  const send = async (method, params) => {
    const request = new Request('https://example.com/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await (await handleMcp(request, hub, 'alice', ['alice', 'alice-laptop'], 'https://example.com', { onlineSeconds: 180, expirySeconds: 28800 }, {})).json()).result;
  };
  assert.equal((await send('initialize', {})).instructions, fixture.mcp.initialize);
  assert.deepEqual((await send('tools/list', {})).tools, fixture.tools);
  assert.equal((await send('tools/call', { name: 'bridge_members' })).content[0].text, fixture.mcp.members);
  const help = (await send('tools/call', { name: 'bridge_help' })).content[0].text;
  assert.equal(help, fixture.mcp.help.replace('GUIDE', setupGuide('https://example.com')));
});

test('no canonical output says task_done closes a task (the state.test.mjs wording guard)', async () => {
  const r = await loadModule('src/rules.ts');
  const { deploymentDefaults: c } = await loadModule('src/deployment.ts');
  const { renderCases } = await import('./rules-cases.mjs');
  const saysDone = /finish(es)? (it )?with task_done|task_done (finishes|closes)|sets it done|Finish a task/i;
  const { setupGuide } = await (await import('./rules-surfaces.mjs')).loadSurfaces();
  assert.doesNotMatch(JSON.stringify(renderCases(r, c)), saysDone);
  assert.doesNotMatch(setupGuide(c.baseUrl), saysDone);
});

test('the committed responder bundle is current and uses the canonical prompt', async () => {
  const { build } = await import('esbuild');
  const { outputFiles } = await build({ entryPoints: [new URL('../bin/responder/main.mjs', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false, banner: { js: '#!/usr/bin/env node' } });
  assert.equal(readFileSync(new URL('../bin/goonbridge-responder.mjs', import.meta.url), 'utf8'), outputFiles[0].text);
  assert.match(outputFiles[0].text, /buildResponderPrompt\(deploymentDefaults, me, m, repo, full\)/);
});

test('prose follows settings inputs for poll, claim, lease, boot, heartbeat, warm age and retention', async () => {
  const r = await loadModule('src/rules.ts');
  const settings = await loadModule('src/hub/settings.ts');
  assert.equal(settings.DELIVERY_KEEP_MS, 7 * 86400_000);
  const { deploymentDefaults } = await loadModule('src/deployment.ts');
  const c = { ...deploymentDefaults, timing: { ...deploymentDefaults.timing, waitSeconds: 11, idleSeconds: 240, claimSeconds: 120, onlineSeconds: 300, leaseSeconds: 123, bootSeconds: 456, deploySeconds: 789, heartbeatSeconds: 45, heartbeatIdleSeconds: 600, warmAgeSeconds: 7200, deliveryKeepSeconds: 2 * 86400 } };
  assert.match(r.stayReachable(c), /wait_seconds 11.*until 4 minutes/);
  const tools = r.buildToolDescriptions(c);
  assert.match(tools.bridge_inbox, /2 minutes by default.*11 seconds/);
  assert.match(tools.bridge_members, /last 5 minutes/);
  const guide = r.buildGuideRules(c);
  assert.match(guide.liveness, /default 123/);
  assert.match(guide.fireFaults, /default 456/);
  assert.match(guide.deployPolicy, /default 789/);
  assert.match(guide.heartbeat, /every 45 seconds.*after 10 minutes/);
  assert.match(guide.warmSessions, /2 hours old/);
  assert.match(guide.deployPolicy, /up to 2 days/);
  assert.match(guide.githubEvents, /kept 2 days/);
});

test('identity inputs are independent, HTML text is escaped, and guide keys must exist', async () => {
  const r = await loadModule('src/rules.ts');
  const { deploymentDefaults } = await loadModule('src/deployment.ts');
  const c = { ...deploymentDefaults, name: 'engine', exampleRepo: 'other-repo', examplePeer: 'bob', ownerDisplayText: "Alice's <bridge>&" };
  assert.match(r.buildToolDescriptions(c).revert_inputSchema_properties_target, /"other-repo"/);
  assert.match(r.buildToolDescriptions(c).bridge_trust_inputSchema_properties_person, /e.g. bob/);
  const home = r.buildHomePage(c, { origin: 'https://example.com', version: '1', deployed: null, tools: [], people: [], standalone: [], claimSeconds: 900, onlineSeconds: 180, expirySeconds: 28800 });
  assert.match(home, /Alice's &#60;bridge&#62;&#38;/);
  assert.throws(() => r.renderGuide('{{RULES.missing}}', c, c.baseUrl), /Unknown guide rule/);
  assert.throws(() => r.renderGuide('{{RULES.toString}}', c, c.baseUrl), /Unknown guide rule/);
});

test('routine, home and revert callers use the canonical builders', owner, async () => {
  const { message, task, review } = await import('./rules-cases.mjs');
  const routines = await loadModule('src/routines.ts');
  assert.equal(routines.payloadFor(message), fixture.payloads[0]);
  assert.equal(routines.payloadFor(message, task), fixture.payloads[1]);
  assert.equal(routines.reviewBrief(review), fixture.reviews[0]);
  const { homePage } = await loadModule('src/home.ts');
  assert.equal(homePage({ origin: readDeployment(baseline.id).deployment.origin, version: '0.1.0', deployed: null, tools: fixture.tools, people: [], standalone: [], claimSeconds: 900, onlineSeconds: 180, expirySeconds: 28800 }), fixture.homes[0]);
  // Resolve an explicit SHA with no recorded task: the read-only SQL returns no rows.
  const { revertTask } = await loadModule('src/hub/revert.ts');
  const sql = { exec: () => ({ toArray: () => [] }) };
  const result = revertTask(sql, 'alice', ['alice', 'alice-cloud'], { target: 'abcdef0', repo: 'example', reason: 'Broken deploy' });
  const r = await loadModule('src/rules.ts');
  assert.equal(result.brief, r.buildRevertBrief({ person: 'alice', how: 'revert merge abcdef0', why: 'Broken deploy', repo: 'example', list: '1. merge commit abcdef0 · deploy unknown' }));
  assert.equal(result.assignee, 'alice-cloud');
  assert.equal(result.state, 'ready');
});
