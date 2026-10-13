import { DEFAULT_BRANCH_PREFIX } from "./defaults";
import { bundledConfig } from './resolve';
import type { BridgeConfig } from './schema';

// Explicit allow-list for public installers and local bridge.json. Never accept a resolved Config:
// credentials, email maps, account identifiers and routine values do not belong in client artifacts.
export function clientConfig(c: BridgeConfig = bundledConfig) {
  return {
    url: c.deployment.origin,
    product_name: c.deployment.productName ?? 'chimera',
    token_env: `${c.compatibility.envPrefix}_TOKEN`,
    env_prefix: c.compatibility.envPrefix,
    approver: c.hooks.approver,
    session_header: `${c.compatibility.headerPrefix}-Session`,
    context_header: `${c.compatibility.headerPrefix}-Context`,
    connector_name: c.clients.connectorName,
    launchd_label: c.clients.launchdLabel,
    responder_name: c.compatibility.assetNames.responder.slice(1),
    cloud_config_ref: c.cloud?.configBundle?.commit ?? 'main',
    state_dir_name: c.clients.stateDirName,
    protected_branches: c.hooks.protectedBranches,
    enabled_hooks: c.hooks.enabled,
    external_skills: c.hooks.externalSkills,
    branch_prefix: c.hooks.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
  };
}
export function clientScript(script: string, c: BridgeConfig = bundledConfig): string {
  const quoted = JSON.stringify(clientConfig(c)).replaceAll("'", "'\"'\"'");
  return script.replace("bridge_defaults='{}' # supplied by the Worker", `bridge_defaults='${quoted}' # supplied by the Worker`);
}
