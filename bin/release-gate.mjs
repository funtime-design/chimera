// Release gate (release.yml): a tag releases only a commit whose most recent staging deploy passed. Reads the Deploy
// workflow's runs for the commit from the Actions API, newest first, and needs the job "deploy (staging)" to have run
// and succeeded. A run still in progress, a failed deploy, or no deploy at all (none, or every one skipped) fails.
// Usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node bin/release-gate.mjs <commit-sha>
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkStagingDeploy({ repo, sha, token, deployment = 'staging', workflow = 'deploy.yml', fetchImpl = fetch, api = 'https://api.github.com' }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('release gate needs a full commit SHA');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('release gate needs GITHUB_REPOSITORY as owner/repo');
  const get = async url => {
    let response;
    try { response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }); }
    catch { throw new Error(`Actions API request failed: ${new URL(url).pathname}`); }
    if (!response.ok) throw new Error(`Actions API HTTP ${response.status}: ${new URL(url).pathname}`);
    return response.json();
  };
  const { workflow_runs: runs = [] } = await get(`${api}/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=50`);
  if (!runs.length) throw new Error(`no Deploy run for ${sha.slice(0, 12)}: merge it to main and let staging deploy it first`);
  const job = `deploy (${deployment})`;
  for (const run of [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    if (run.status !== 'completed') throw new Error(`the Deploy run ${run.id} for ${sha.slice(0, 12)} is still running; tag again after it finishes`);
    const { jobs = [] } = await get(`${api}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    const found = jobs.find(j => j.name === job);
    if (!found || found.conclusion === 'skipped') continue;
    if (found.conclusion !== 'success') throw new Error(`the most recent staging deploy of ${sha.slice(0, 12)} (run ${run.id}) ended in ${found.conclusion}`);
    return run;
  }
  throw new Error(`no staging deploy ran for ${sha.slice(0, 12)} (is DEPLOYMENT=staging set and are its secrets present?)`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const run = await checkStagingDeploy({ repo: process.env.GITHUB_REPOSITORY, sha: process.argv[2], token: process.env.GITHUB_TOKEN });
    console.log(`Staging deploy passed for this commit (Deploy run ${run.id})`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
