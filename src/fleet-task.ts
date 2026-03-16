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

// --- Types ---

export interface FleetTaskConfig {
  repoName: string;
  description: string;
  agents?: string; // comma-separated agent names (default: bootstrap.sh defaults)
  manifest?: string; // inline manifest YAML content
  timeoutMinutes?: number;
  target?: string; // 'local' (default), future: 'azure', 'ssh://host'
}

export interface FleetTaskMount {
  worktreePath: string;
  repoGitDir: string;
  repoName: string;
  branch: string;
  teamContext: string;
  fleetStatusDir: string; // host path to fleet status directory
}

// --- Pattern ---

// Pattern: "fleet <repo> <description>"
// Optional flags: --agents eng1,eng2,qa1 --timeout 60
const FLEET_TASK_PATTERN = /^fleet\s+(\S+)\s+(.+)$/is;

/**
 * Detect if a message is a fleet task request.
 * Returns parsed config or null.
 */
export function parseFleetTask(content: string): FleetTaskConfig | null {
  // Strip the trigger prefix (e.g., "@NanoClaw ") and any Slack user mentions
  const stripped = content
    .replace(/^@\S+\s+/i, '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim();

  const match = stripped.match(FLEET_TASK_PATTERN);
  if (!match) return null;

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
  worktreeInfo: WorktreeInfo;
  fleetMount: FleetTaskMount;
  restoreGitPaths: () => void;
}

/**
 * Set up a fleet task: resolve repo, create worktree, prepare mounts.
 */
export async function setupFleetTask(
  config: FleetTaskConfig,
): Promise<FleetSetupResult> {
  const target = config.target || FLEET_TARGET;
  if (target !== 'local') {
    // Future: dispatch to Azure/remote host
    throw new Error(
      `Fleet target "${target}" not yet supported. Only "local" is available.`,
    );
  }

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
  logger.info({ target, fleetStatusDir, repoName: config.repoName }, 'Fleet task setup');

  const fleetMount: FleetTaskMount = {
    worktreePath: worktreeInfo.worktreePath,
    repoGitDir: worktreeInfo.repoGitDir,
    repoName: worktreeInfo.repoName,
    branch: worktreeInfo.branch,
    teamContext,
    fleetStatusDir,
  };

  return { worktreeInfo, fleetMount, restoreGitPaths };
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
      logger.warn({ fleetStatusDir, err }, 'Failed to clean up fleet status directory');
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
