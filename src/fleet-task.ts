/**
 * Fleet Task Module for NanoClaw
 *
 * Triggers ai-fleet bootstrap.sh inside a container to run multi-agent fleets.
 * Reuses the coding task worktree infrastructure for repo access.
 *
 * Host-side only — the fleet runs entirely inside the container.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, FLEET_TARGET, NANOCLAW_OWNER } from './config.js';
import {
  createWorktree,
  cleanupWorktree,
  patchWorktreeForContainer,
  loadTeamContext,
  writeJournal,
  resolveRepo,
  WorktreeInfo,
} from './coding-task.js';
import { logger } from './logger.js';
import {
  dispatchFleetToACI,
  cleanupAciFleet,
  AciFleetResult,
} from './fleet-dispatch-aci.js';
import { parseWorkItem, extractDescription } from './work-item-parser.js';

// --- Types ---

export interface FleetTaskConfig {
  repoName: string;
  description: string;
  agents?: string; // comma-separated agent names (default: bootstrap.sh defaults)
  manifest?: string; // inline manifest YAML content
  timeoutMinutes?: number;
  target?: string; // 'local' or 'azure'
  issueNumber?: string; // GitHub issue number or ADO work item ID
  branch?: string; // branch to check out or create
  modelStrategy?: string; // all-opus, all-sonnet, mixed (default)
}

export interface FleetTaskMount {
  worktreePath: string;
  repoGitDir: string;
  repoName: string;
  branch: string;
  teamContext: string;
  fleetStatusDir: string; // host path to fleet status directory
}

// --- Fleet target resolution ---

export type FleetTarget = 'azure' | 'local';

/**
 * Resolve where a fleet should run. Called before setupFleetTask().
 *
 * Decision factors:
 *   - Explicit override (--target flag) takes precedence
 *   - Repo sensitivity: production HopSkip repos → azure, personal repos → local
 *   - Host environment: if running in Azure (Container App), default to azure
 *   - Mac Mini availability: if reachable via Tailscale, can route R&D there
 *   - Cost: cheap tasks can go local to save Azure spend
 *
 * This is intentionally simple now — a lookup table + env check.
 * Future: integrate with estimate results and availability probes.
 */
export function resolveFleetTarget(config: FleetTaskConfig): FleetTarget {
  // Explicit override always wins
  if (config.target === 'azure' || config.target === 'local') {
    return config.target;
  }

  // If the host is running in Azure (Container App sets CONTAINER_APP_NAME),
  // default to ACI dispatch — the host can't run local Docker anyway.
  if (process.env.CONTAINER_APP_NAME) {
    return 'azure';
  }

  // Fall back to configured default (local for dev, azure for production)
  return (FLEET_TARGET as FleetTarget) || 'local';
}

// --- Pattern ---

// Pattern: "fleet <repo> <description>"
// Optional flags: --agents eng1,eng2,qa1 --timeout 60
const FLEET_TASK_PATTERN = /^fleet\s+(\S+)\s+(.+)$/is;

// Pattern: "fleet <url-or-shorthand>" (no separate description — context comes from the work item)
const FLEET_URL_PATTERN = /^fleet\s+(.+)$/is;

/**
 * Detect if a message is a fleet task request.
 * Tries URL/work-item parsing first, then falls back to the legacy "fleet <repo> <description>" pattern.
 * Returns parsed config or null.
 */
export function parseFleetTask(content: string): FleetTaskConfig | null {
  // Strip the trigger prefix (e.g., "@NanoClaw ") and any Slack user mentions
  const stripped = content
    .replace(/^@\S+\s+/i, '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim();

  // Must start with "fleet"
  const urlMatch = stripped.match(FLEET_URL_PATTERN);
  if (!urlMatch) return null;

  const remainder = urlMatch[1];

  // --- Try URL / work item parsing first ---
  const workItem = parseWorkItem(remainder);
  if (workItem) {
    const repoName =
      workItem.source === 'ado'
        ? `ado:${workItem.repoSlug}`
        : workItem.repoSlug;
    const userDesc = extractDescription(remainder, workItem);

    // Parse optional flags from the remaining description
    let description = userDesc;
    let agents: string | undefined;
    let timeoutMinutes: number | undefined;

    const agentsMatch = description.match(/--agents\s+(\S+)/);
    if (agentsMatch) {
      agents = agentsMatch[1];
      description = description.replace(agentsMatch[0], '').trim();
    }

    const timeoutMatch = description.match(/--timeout\s+(\d+)/);
    if (timeoutMatch) {
      timeoutMinutes = parseInt(timeoutMatch[1], 10);
      description = description.replace(timeoutMatch[0], '').trim();
    }

    const defaultDesc =
      workItem.source === 'ado'
        ? `ADO work item #${workItem.number}`
        : `GitHub ${workItem.type === 'pull_request' ? 'PR' : 'issue'} #${workItem.number}`;

    return {
      repoName,
      description: description || defaultDesc,
      agents,
      timeoutMinutes,
      issueNumber: String(workItem.number),
    };
  }

  // --- Legacy pattern: "fleet <repo> <description>" ---
  const match = stripped.match(FLEET_TASK_PATTERN);
  if (!match) return null;

  // Validate repo exists in local registry — if not, return null so NL classifier can handle it
  const repo = resolveRepo(match[1]);
  if (!repo) return null;

  const repoName = match[1];
  let description = match[2];

  // Parse optional inline flags from description
  let agents: string | undefined;
  let timeoutMinutes: number | undefined;

  const agentsMatch = description.match(/--agents\s+(\S+)/);
  if (agentsMatch) {
    agents = agentsMatch[1];
    description = description.replace(agentsMatch[0], '').trim();
  }

  const timeoutMatch = description.match(/--timeout\s+(\d+)/);
  if (timeoutMatch) {
    timeoutMinutes = parseInt(timeoutMatch[1], 10);
    description = description.replace(timeoutMatch[0], '').trim();
  }

  return { repoName, description, agents, timeoutMinutes };
}

// --- Fleet status directory ---

const FLEET_STATUS_BASE = path.join(DATA_DIR, 'fleet-status');

function createFleetStatusDir(worktreeId: string): string {
  const statusDir = path.join(FLEET_STATUS_BASE, worktreeId);
  fs.mkdirSync(statusDir, { recursive: true });
  return statusDir;
}

// --- Fleet task setup ---

export interface FleetSetupResult {
  mode: 'local';
  worktreeInfo: WorktreeInfo;
  fleetMount: FleetTaskMount;
  restoreGitPaths: () => void;
}

export interface FleetSetupResultAci {
  mode: 'azure';
  aciResult: AciFleetResult;
  /** Azure Files path to poll for fleet-status.json */
  statusPath: string;
}

/**
 * Set up a fleet task.
 * - target='local': creates worktree + mounts for local Docker container
 * - target='azure': dispatches to ACI (container clones repo, no local worktree)
 */
export async function setupFleetTask(
  config: FleetTaskConfig,
): Promise<FleetSetupResult | FleetSetupResultAci> {
  const target = resolveFleetTarget(config);

  if (target === 'azure') {
    // --- ACI dispatch: container handles clone, push, PR ---
    // The repo name from the command IS the slug (e.g. "HopSkipInc/SomeRepo")
    // If the host has a local clone, load team context from it; otherwise skip
    const repo = resolveRepo(config.repoName);
    const repoSlug = config.repoName;
    const teamContext = repo ? loadTeamContext(repo.path) : '';

    logger.info(
      { target, repoSlug, repoName: config.repoName },
      'Dispatching fleet to ACI',
    );

    const aciResult = await dispatchFleetToACI({
      repoSlug,
      description: config.description,
      agents: config.agents,
      timeoutMinutes: config.timeoutMinutes,
      teamContext,
      branch: config.branch,
      issueNumber: config.issueNumber,
      modelStrategy: config.modelStrategy,
    });

    return {
      mode: 'azure',
      aciResult,
      statusPath: aciResult.statusPath,
    };
  }

  // --- Local Docker: create worktree + mounts (existing behavior) ---
  const repo = resolveRepo(config.repoName);
  if (!repo) {
    throw new Error(
      `Repo "${config.repoName}" not found or not allowed. Check ~/.config/nanoclaw/repo-registry.json`,
    );
  }

  const worktreeInfo = await createWorktree(
    repo,
    NANOCLAW_OWNER,
    config.description,
  );

  const teamContext = loadTeamContext(worktreeInfo.repoPath);
  const fleetStatusDir = createFleetStatusDir(worktreeInfo.id);
  const restoreGitPaths = patchWorktreeForContainer(worktreeInfo);
  logger.info(
    { target, fleetStatusDir, repoName: config.repoName },
    'Fleet task setup (local)',
  );

  const fleetMount: FleetTaskMount = {
    worktreePath: worktreeInfo.worktreePath,
    repoGitDir: worktreeInfo.repoGitDir,
    repoName: worktreeInfo.repoName,
    branch: worktreeInfo.branch,
    teamContext,
    fleetStatusDir,
  };

  return { mode: 'local', worktreeInfo, fleetMount, restoreGitPaths };
}

/**
 * Clean up an ACI fleet (delete container group).
 */
export async function cleanupAciFleetTask(
  containerGroupName: string,
): Promise<void> {
  await cleanupAciFleet(containerGroupName);
}

/**
 * Clean up fleet task resources (worktree + status dir).
 */
export async function cleanupFleetTask(
  worktreeInfo: WorktreeInfo,
  fleetStatusDir?: string,
): Promise<void> {
  await cleanupWorktree(worktreeInfo);
  if (fleetStatusDir) {
    try {
      fs.rmSync(fleetStatusDir, { recursive: true, force: true });
      logger.info({ fleetStatusDir }, 'Fleet status directory cleaned up');
    } catch (err) {
      logger.warn(
        { fleetStatusDir, err },
        'Failed to clean up fleet status directory',
      );
    }
  }
}

/**
 * Read fleet status from the status directory.
 */
export function readFleetStatus(
  fleetStatusDir: string,
): { status: string; message: string } | null {
  const statusFile = path.join(fleetStatusDir, 'fleet-status.json');
  try {
    if (fs.existsSync(statusFile)) {
      const data = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      return { status: data.status || 'unknown', message: data.message || '' };
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}

/**
 * Read PR URL from fleet-status.json.
 * Written by fleet-complete when the super agent passes a PR URL.
 */
export function readFleetPrUrl(fleetStatusDir: string): string | null {
  const statusFile = path.join(fleetStatusDir, 'fleet-status.json');
  try {
    if (fs.existsSync(statusFile)) {
      const data = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      return data.pr_url || null;
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}

/**
 * Write a journal entry for a completed fleet task.
 */
export async function writeFleetJournal(
  repoName: string,
  description: string,
  outcome: string,
): Promise<void> {
  await writeJournal({
    repo: repoName,
    title: `Fleet: ${description.slice(0, 60)}`,
    why: 'Fleet task requested via Slack',
    what: description,
    outcome,
  });
}

/**
 * Build the fleet PR body.
 */
export function buildFleetPrBody(opts: {
  owner: string;
  channel: string;
  branch: string;
  description: string;
  fleetStatus?: string;
}): string {
  return `## NanoClaw Fleet Task

**Owner:** ${opts.owner}
**Requested via:** Slack (${opts.channel})
**Branch:** ${opts.branch}

### Task
${opts.description}

### Fleet Result
${opts.fleetStatus || '_Fleet did not report a summary._'}`;
}
