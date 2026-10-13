import { DEFAULT_BRANCH_PREFIX } from "./config/defaults";
import { claimSeconds, claimLeaseSeconds, bootSeconds, deploySeconds, onlineSeconds, statusExpirySeconds, MAX_WAIT_SECONDS, REACHABLE_IDLE_SECONDS, HEARTBEAT_INTERVAL_SECONDS, HEARTBEAT_IDLE_SECONDS, WARM_MAX_AGE_MS, DELIVERY_KEEP_MS, SESSION_TTL_MS, WORK_THREAD_KEEP_MS } from "./hub/settings.ts";
import { cloudMember } from "./config/names";
import { resolveConfig, type Config } from "./config/resolve";

// Presentation uses engine timing defaults (the guide's existing contract), while runtime settings
// come from config + env. No secret values are copied into text or client bundles.
export function deploymentText(c: Config) {
  const owner = c.presentation?.owner ?? c.hooks.approver;
  return {
    name: c.deployment.productName,
    owner,
    ownerDisplayName: owner[0].toUpperCase() + owner.slice(1),
    ownerDisplayText: c.deployment.displayName,
    ownerPossessive: "their", ownerSubject: "they", ownerObject: "them",
    exampleDevice: owner + "-laptop", exampleSecondDevice: owner + "-desktop",
    exampleCloud: cloudMember(owner), exampleSession: cloudMember(owner) + "-x7k-" + c.deployment.id,
    exampleRepo: c.deployment.id, examplePeer: "bob",
    connectorName: c.clients.connectorName, stateDirName: c.clients.stateDirName,
    githubOwner: c.github.owner,
    guideIntroduction: `${c.deployment.displayName} at {{BASE_URL}} connects agents and devices with messages, a status board and a task backlog.`,
    guideCloudSetup: 'Configure the deployment token and service credentials in the cloud environment. Never store credential values in the repository.',
    guideExternalSkills: 'External skills are optional deployment configuration. Review and pin their sources before enabling them.',
    guideWebhookSetup: `Configure a GitHub webhook at {{BASE_URL}}/v1/github/webhook for repositories owned by ${c.github.owner}. Use the deployment webhook secret and subscribe to pull requests, checks, branch deletion, workflow runs and deployment statuses.`,
    guideBackfill: 'Use an owner-authorized stamp to record a merge the webhook missed.',
    // Trusted HTML fragment (deployment config, not user input) completing "each member has one, ..." on the home page.
    guideTokenStorage: "kept in the deployment's secret store",
    guideRoutineSecrets: 'Set each with `wrangler secret put`, piping the value from your secret store if you keep it there.',
    baseUrl: c.deployment.origin, envPrefix: c.compatibility.envPrefix,
    sessionHeader: c.compatibility.headerPrefix + "-Session", contextHeader: c.compatibility.headerPrefix + "-Context",
    responderAsset: c.compatibility.assetNames.responder, connectorAsset: c.compatibility.assetNames.connector,
    responderCommand: c.deployment.productName + "-responder",
    branchPrefix: c.hooks.branchPrefix ?? DEFAULT_BRANCH_PREFIX, labels: c.labels,
    ...c.presentation,
    timing: {
      claimSeconds: claimSeconds(undefined), leaseSeconds: claimLeaseSeconds(undefined),
      bootSeconds: bootSeconds(undefined), deploySeconds: deploySeconds(undefined),
      onlineSeconds: onlineSeconds(undefined), expirySeconds: statusExpirySeconds(undefined),
      waitSeconds: MAX_WAIT_SECONDS, idleSeconds: REACHABLE_IDLE_SECONDS,
      heartbeatSeconds: HEARTBEAT_INTERVAL_SECONDS, heartbeatIdleSeconds: HEARTBEAT_IDLE_SECONDS,
      warmAgeSeconds: WARM_MAX_AGE_MS / 1000,
      deliveryKeepSeconds: DELIVERY_KEEP_MS / 1000, sessionTtlSeconds: SESSION_TTL_MS / 1000,
      workThreadKeepSeconds: WORK_THREAD_KEEP_MS / 1000,
    },
  };
}
export const deploymentDefaults = deploymentText(resolveConfig());
export type DeploymentText = ReturnType<typeof deploymentText>;
