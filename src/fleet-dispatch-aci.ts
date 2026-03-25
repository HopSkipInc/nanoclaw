/**
 * Fleet Dispatch — Azure Container Instances
 *
 * Creates ephemeral ACI container groups to run fleet tasks in the cloud.
 * Each fleet gets its own container group with:
 *   - Fleet container image from ACR (ai-fleet toolkit baked in)
 *   - Azure Files volume for fleet-status exchange with the host
 *   - GitHub/ADO tokens from Key Vault for repo clone + PR creation
 *   - Anthropic API key from Key Vault for agent inference
 *   - Fleet config passed as FLEET_CONFIG_JSON env var (no stdin in ACI)
 *
 * Separation of concerns:
 *   Host (NanoClaw):  dispatch container, poll status from Azure Files, relay to Slack
 *   Fleet container:  clone repo, run agents, push branch, create PR, write status
 */
import crypto from 'crypto';
import { logger } from './logger.js';
import { loadRepoRegistry } from './coding-task.js';

// --- Types ---

export interface AciFleetConfig {
  /** e.g. "HopSkipInc/SomeRepo" or "ado:Doorbell/SomeService" */
  repoSlug: string;
  /** Fleet goal / task description */
  description: string;
  /** Comma-separated agent names (default: bootstrap.sh defaults) */
  agents?: string;
  /** Timeout in minutes */
  timeoutMinutes?: number;
  /** Team context markdown to inject into .claude/team-context.md */
  teamContext?: string;
  /** Branch to check out (or create) */
  branch?: string;
  /** GitHub issue number or ADO work item ID */
  issueNumber?: string;
  /** Model strategy: all-opus, all-sonnet, mixed (default) */
  modelStrategy?: string;
}

export interface AciFleetResult {
  /** ACI container group name (for tracking/cleanup) */
  containerGroupName: string;
  /** Fleet ID used for status directory on Azure Files */
  fleetId: string;
  /** Azure Files path where fleet-status.json will appear */
  statusPath: string;
}

// --- Azure config ---

// These are read from env (set by Container App configuration or .env for local dev)
const ACI_RESOURCE_GROUP = process.env.ACI_RESOURCE_GROUP || 'rg-ai-fleet-prod';
const ACI_LOCATION = process.env.ACI_LOCATION || 'eastus2';
const ACI_SUBSCRIPTION_ID = process.env.ACI_SUBSCRIPTION_ID || '';
const ACI_MANAGED_IDENTITY_ID = process.env.ACI_MANAGED_IDENTITY_ID || '';
// Client ID (UUID) for MI token requests — distinct from the full resource ID
const ACI_MI_CLIENT_ID =
  process.env.ACI_MI_CLIENT_ID ||
  process.env.ACI_MANAGED_IDENTITY_CLIENT_ID ||
  '';
const ACI_ACR_SERVER =
  process.env.ACI_ACR_SERVER || 'aifleetprodacr.azurecr.io';
const ACI_FLEET_IMAGE =
  process.env.ACI_FLEET_IMAGE || `${ACI_ACR_SERVER}/ai-fleet:latest`;
const ACI_KEY_VAULT_URI =
  process.env.KEY_VAULT_URI || 'https://ai-fleet-prod-kv.vault.azure.net/';
const ACI_STORAGE_ACCOUNT = process.env.ACI_STORAGE_ACCOUNT || 'aifleetprodst';
const ACI_FILE_SHARE = process.env.ACI_FILE_SHARE || 'fleet-status';
const ACI_STORAGE_KEY = process.env.ACI_STORAGE_KEY || ''; // populated at runtime from KV

// Container sizing (can be overridden per-fleet in the future)
const ACI_CPU = parseFloat(process.env.ACI_CPU || '2');
const ACI_MEMORY_GB = parseFloat(process.env.ACI_MEMORY_GB || '4');

/**
 * Get an access token for Azure Resource Manager using Managed Identity.
 * Works when running inside a Container App / ACI / VM with MI configured.
 */
async function getArmToken(): Promise<string> {
  const endpoint =
    process.env.IDENTITY_ENDPOINT ||
    'http://169.254.169.254/metadata/identity/oauth2/token';
  const identityHeader = process.env.IDENTITY_HEADER;

  const params = new URLSearchParams({
    'api-version': '2019-08-01',
    resource: 'https://management.azure.com/',
  });

  if (ACI_MI_CLIENT_ID) {
    params.set('client_id', ACI_MI_CLIENT_ID);
  }

  const headers: Record<string, string> = { Metadata: 'true' };
  if (identityHeader) {
    headers['X-IDENTITY-HEADER'] = identityHeader;
  }

  const res = await fetch(`${endpoint}?${params}`, { headers });
  if (!res.ok) {
    throw new Error(
      `MI token request failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Get a secret from Key Vault using Managed Identity.
 */
async function getKeyVaultSecret(secretName: string): Promise<string> {
  const endpoint =
    process.env.IDENTITY_ENDPOINT ||
    'http://169.254.169.254/metadata/identity/oauth2/token';
  const identityHeader = process.env.IDENTITY_HEADER;

  const params = new URLSearchParams({
    'api-version': '2019-08-01',
    resource: 'https://vault.azure.net',
  });
  if (ACI_MI_CLIENT_ID) {
    params.set('client_id', ACI_MI_CLIENT_ID);
  }

  const headers: Record<string, string> = { Metadata: 'true' };
  if (identityHeader) {
    headers['X-IDENTITY-HEADER'] = identityHeader;
  }

  const tokenRes = await fetch(`${endpoint}?${params}`, { headers });
  if (!tokenRes.ok) {
    throw new Error(
      `KV token request failed: ${tokenRes.status} ${await tokenRes.text()}`,
    );
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const kvUrl = `${ACI_KEY_VAULT_URI}secrets/${secretName}?api-version=7.4`;
  const secretRes = await fetch(kvUrl, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!secretRes.ok) {
    throw new Error(
      `KV secret '${secretName}' fetch failed: ${secretRes.status}`,
    );
  }
  const secret = (await secretRes.json()) as { value: string };
  return secret.value;
}

/**
 * Generate a short-lived GitHub App installation token (~1 hour).
 * Uses the App's private key to create a JWT, then exchanges it for an
 * installation access token via the GitHub API.
 */
async function generateGitHubInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<string> {
  // Create JWT signed with the App's RSA private key
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey, 'base64url');

  const jwt = `${header}.${payload}.${signature}`;

  // Exchange JWT for installation token
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    throw new Error(
      `GitHub installation token request failed: ${res.status} ${await res.text()}`,
    );
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

/**
 * Dispatch a fleet task to Azure Container Instances.
 *
 * Creates an ephemeral container group that:
 * 1. Clones the repo (GitHub App token or ADO PAT from KV)
 * 2. Runs bootstrap.sh with the fleet config
 * 3. Writes fleet-status.json to Azure Files
 * 4. Super agent pushes branch + creates PR
 * 5. Container exits when fleet-complete is called
 */
export async function dispatchFleetToACI(
  config: AciFleetConfig,
): Promise<AciFleetResult> {
  const fleetId = `fleet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const containerGroupName = `ai-fleet-${fleetId}`;

  logger.info(
    { fleetId, repoSlug: config.repoSlug, containerGroupName },
    'Dispatching fleet to ACI',
  );

  // Fetch secrets from Key Vault
  // GitHub uses App credentials — we fetch the private key, app ID, and
  // installation ID, then generate a short-lived installation token.
  // ADO uses a long-lived PAT (org is MSA-backed, not Entra).
  const [
    anthropicKey,
    githubAppPrivateKey,
    githubAppId,
    githubInstallationId,
    adoPat,
    storageKey,
  ] = await Promise.all([
    getKeyVaultSecret('anthropic-api-key'),
    getKeyVaultSecret('github-app-private-key').catch(() => ''),
    getKeyVaultSecret('github-app-id').catch(() => ''),
    getKeyVaultSecret('github-app-installation-id').catch(() => ''),
    getKeyVaultSecret('azdo-pat').catch(() => ''),
    ACI_STORAGE_KEY || getKeyVaultSecret('storage-account-key'),
  ]);

  // Generate GitHub App installation token (short-lived, ~1 hour)
  let githubToken = '';
  if (githubAppPrivateKey && githubAppId && githubInstallationId) {
    githubToken = await generateGitHubInstallationToken(
      githubAppId,
      githubAppPrivateKey,
      githubInstallationId,
    );
  }

  // Build fleet config JSON for the container (passed as env var)
  const fleetConfigJson = JSON.stringify({
    fleetTask: {
      description: config.description,
      agents: config.agents,
      timeoutMinutes: config.timeoutMinutes,
      teamContext: config.teamContext,
      repoSlug: config.repoSlug,
      branch: config.branch,
      issueNumber: config.issueNumber,
      modelStrategy: config.modelStrategy || 'mixed',
    },
  });

  // Determine which token the container needs
  const isAdo = config.repoSlug.startsWith('ado:');
  const repoToken = isAdo ? adoPat : githubToken;
  const repoTokenEnvName = isAdo ? 'ADO_PAT' : 'GITHUB_TOKEN';

  if (!repoToken) {
    throw new Error(
      `No ${repoTokenEnvName} available in Key Vault for repo ${config.repoSlug}`,
    );
  }

  // Get ARM token for container creation
  const armToken = await getArmToken();

  // Create ACI container group via REST API
  const aciUrl = `https://management.azure.com/subscriptions/${ACI_SUBSCRIPTION_ID}/resourceGroups/${ACI_RESOURCE_GROUP}/providers/Microsoft.ContainerInstance/containerGroups/${containerGroupName}?api-version=2023-05-01`;

  const containerGroupBody = {
    location: ACI_LOCATION,
    identity: {
      type: 'UserAssigned',
      userAssignedIdentities: {
        [ACI_MANAGED_IDENTITY_ID]: {},
      },
    },
    properties: {
      osType: 'Linux',
      restartPolicy: 'Never',
      containers: [
        {
          name: 'fleet',
          properties: {
            image: ACI_FLEET_IMAGE,
            command: ['/opt/ai-fleet/entrypoint.sh'],
            resources: {
              requests: {
                cpu: ACI_CPU,
                memoryInGB: ACI_MEMORY_GB,
              },
            },
            environmentVariables: [
              { name: 'FLEET_CONFIG_JSON', secureValue: fleetConfigJson },
              { name: 'ANTHROPIC_API_KEY', secureValue: anthropicKey },
              { name: repoTokenEnvName, secureValue: repoToken },
              { name: 'NANOCLAW_FLEET_TASK', value: '1' },
              { name: 'FLEET_ID', value: fleetId },
              // Individual env vars for entrypoint.sh compatibility
              { name: 'REPO_SLUG', value: config.repoSlug },
              {
                name: 'BRANCH',
                value:
                  config.branch ||
                  lookupDefaultBranch(config.repoSlug) ||
                  'main',
              },
              { name: 'FLEET_GOAL', value: config.description },
              ...(config.issueNumber
                ? [{ name: 'FLEET_ISSUE', value: config.issueNumber }]
                : []),
              { name: 'TERM', value: 'xterm' },
              {
                name: 'FLEET_STATUS_DIR',
                value: `/workspace/fleet-status/${fleetId}`,
              },
            ],
            volumeMounts: [
              {
                name: 'fleet-status',
                mountPath: '/workspace/fleet-status',
                readOnly: false,
              },
            ],
          },
        },
      ],
      volumes: [
        {
          name: 'fleet-status',
          azureFile: {
            shareName: ACI_FILE_SHARE,
            storageAccountName: ACI_STORAGE_ACCOUNT,
            storageAccountKey: storageKey,
            readOnly: false,
          },
        },
      ],
      imageRegistryCredentials: [
        {
          server: ACI_ACR_SERVER,
          identity: ACI_MANAGED_IDENTITY_ID,
        },
      ],
    },
  };

  const createRes = await fetch(aciUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${armToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(containerGroupBody),
  });

  if (!createRes.ok) {
    const errorBody = await createRes.text();
    throw new Error(
      `ACI container group creation failed: ${createRes.status} ${errorBody}`,
    );
  }

  logger.info(
    { fleetId, containerGroupName, status: createRes.status },
    'ACI container group created',
  );

  // The fleet writes status to Azure Files at /fleet-status/<fleetId>/
  // The status path is relative to the file share root
  const statusPath = fleetId;

  return {
    containerGroupName,
    fleetId,
    statusPath,
  };
}

/**
 * Delete an ACI container group after the fleet completes.
 * Called by the host after reading terminal status from Azure Files.
 */
export async function cleanupAciFleet(
  containerGroupName: string,
): Promise<void> {
  const armToken = await getArmToken();
  const aciUrl = `https://management.azure.com/subscriptions/${ACI_SUBSCRIPTION_ID}/resourceGroups/${ACI_RESOURCE_GROUP}/providers/Microsoft.ContainerInstance/containerGroups/${containerGroupName}?api-version=2023-05-01`;

  const res = await fetch(aciUrl, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${armToken}` },
  });

  if (!res.ok && res.status !== 404) {
    logger.warn(
      { containerGroupName, status: res.status },
      'Failed to delete ACI container group',
    );
  } else {
    logger.info({ containerGroupName }, 'ACI container group deleted');
  }
}

/**
 * Look up the default branch for a repo from the repo registry.
 * Returns undefined if not found.
 */
function lookupDefaultBranch(repoSlug: string): string | undefined {
  try {
    const registry = loadRepoRegistry();
    if (!registry) return undefined;
    // repoSlug is "org/repo" — registry keys are just "repo"
    const repoName = repoSlug.includes('/')
      ? repoSlug.split('/').pop()!
      : repoSlug;
    const entry = registry.repos[repoName];
    return entry?.defaultBranch;
  } catch {
    return undefined;
  }
}
