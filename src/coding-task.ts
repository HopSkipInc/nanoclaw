/**
 * Coding Task Module for NanoClaw
 *
 * Manages git worktrees for safe coding tasks:
 * - Creates worktrees from registered repos
 * - Mounts worktrees into containers for agent coding
 * - Pushes branches and creates PRs via gh CLI
 * - Cleans up worktrees after PR creation
 *
 * Host-side only — containers never run git push or gh.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { REPO_REGISTRY_PATH, NANOCLAW_OWNER, DATA_DIR } from './config.js';
import { logger } from './logger.js';

// --- Types ---

export interface RepoEntry {
  path: string;
  defaultBranch: string;
  allowed: boolean;
  description?: string;
}

export interface RepoRegistry {
  repos: Record<string, RepoEntry>;
}

export interface WorktreeInfo {
  id: string;
  worktreePath: string;
  branch: string;
  repoName: string;
  repoPath: string;
  defaultBranch: string;
}

export interface PrResult {
  prUrl: string;
  prNumber: number;
  branch: string;
}

export interface JournalEntry {
  repo: string;
  title: string;
  why: string;
  what: string;
  outcome: string;
}

// --- Constants ---

const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');

const PROTECTED_BRANCHES = new Set([
  'main',
  'master',
  'develop',
  'production',
  'staging',
]);

// --- Registry ---

let cachedRegistry: RepoRegistry | null = null;
let registryLoadError: string | null = null;

export function loadRepoRegistry(): RepoRegistry | null {
  if (cachedRegistry !== null) return cachedRegistry;
  if (registryLoadError !== null) return null;

  try {
    const registryPath = getRegistryPath();
    if (!fs.existsSync(registryPath)) {
      registryLoadError = `Repo registry not found at ${registryPath}`;
      logger.warn({ path: registryPath }, 'Repo registry not found');
      return null;
    }

    const content = fs.readFileSync(registryPath, 'utf-8');
    const registry = JSON.parse(content) as RepoRegistry;

    if (!registry.repos || typeof registry.repos !== 'object') {
      throw new Error('repos must be an object');
    }

    cachedRegistry = registry;
    logger.info(
      { path: registryPath, repoCount: Object.keys(registry.repos).length },
      'Repo registry loaded',
    );
    return cachedRegistry;
  } catch (err) {
    registryLoadError = err instanceof Error ? err.message : String(err);
    logger.error(
      { path: getRegistryPath(), error: registryLoadError },
      'Failed to load repo registry',
    );
    return null;
  }
}

/** For testing — reset the cached registry and optionally set override path */
let registryPathOverride: string | null = null;

export function _resetRegistryCache(pathOverride?: string): void {
  cachedRegistry = null;
  registryLoadError = null;
  registryPathOverride = pathOverride ?? null;
}

function getRegistryPath(): string {
  return registryPathOverride ?? REPO_REGISTRY_PATH;
}

function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  if (p === '~') return homeDir;
  return path.resolve(p);
}

export function resolveRepo(repoName: string): RepoEntry | null {
  const registry = loadRepoRegistry();
  if (!registry) return null;

  // Case-insensitive lookup
  const key = Object.keys(registry.repos).find(
    (k) => k.toLowerCase() === repoName.toLowerCase(),
  );
  if (!key) return null;

  const entry = registry.repos[key];
  if (!entry.allowed) {
    logger.warn({ repo: repoName }, 'Repo found but not allowed');
    return null;
  }

  return { ...entry, path: expandPath(entry.path) };
}

// --- Slug generation ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

// --- Worktree lifecycle ---

export async function createWorktree(
  repo: RepoEntry,
  owner: string,
  description: string,
): Promise<WorktreeInfo> {
  const repoPath = expandPath(repo.path);
  const id = randomUUID();
  const slug = slugify(description);
  const branch = `nanoclaw/${owner}/${slug}`;

  if (PROTECTED_BRANCHES.has(branch)) {
    throw new Error(
      `Refusing to create worktree on protected branch: ${branch}`,
    );
  }

  const worktreePath = path.join(WORKTREES_DIR, id);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Fetch latest from origin before creating worktree
  try {
    execSync('git fetch origin', {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    logger.warn(
      { repoPath, err },
      'git fetch failed, proceeding with local state',
    );
  }

  // Create worktree with new branch from origin/defaultBranch
  const base = `origin/${repo.defaultBranch}`;
  execSync(
    `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)} ${base}`,
    { cwd: repoPath, stdio: 'pipe', timeout: 30000 },
  );

  // Set git identity in the worktree
  execSync(`git config user.name "NanoClaw (${owner})"`, {
    cwd: worktreePath,
    stdio: 'pipe',
  });
  execSync(`git config user.email "nanoclaw@${owner}"`, {
    cwd: worktreePath,
    stdio: 'pipe',
  });

  logger.info({ id, branch, worktreePath, repoPath }, 'Worktree created');

  return {
    id,
    worktreePath,
    branch,
    repoName: path.basename(repoPath),
    repoPath,
    defaultBranch: repo.defaultBranch,
  };
}

export async function finalizeCodingTask(
  info: WorktreeInfo,
  title: string,
  body: string,
): Promise<PrResult> {
  // Safety: never push to protected branches
  if (PROTECTED_BRANCHES.has(info.branch)) {
    throw new Error(`Refusing to push protected branch: ${info.branch}`);
  }

  // Check for commits on the branch beyond the base
  const commitCount = execSync(
    `git rev-list --count origin/${info.defaultBranch}..HEAD`,
    { cwd: info.worktreePath, encoding: 'utf-8', timeout: 10000 },
  ).trim();

  if (commitCount === '0') {
    throw new Error('No commits to push — agent made no changes');
  }

  // Push branch (no --force)
  execSync(`git push origin ${JSON.stringify(info.branch)}`, {
    cwd: info.worktreePath,
    stdio: 'pipe',
    timeout: 60000,
  });

  logger.info({ branch: info.branch }, 'Branch pushed');

  // Create PR via gh CLI
  const prOutput = execSync(
    `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --base ${info.defaultBranch} --head ${info.branch}`,
    { cwd: info.worktreePath, encoding: 'utf-8', timeout: 30000 },
  ).trim();

  // gh pr create outputs the PR URL
  const prUrl = prOutput;
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;

  logger.info({ prUrl, prNumber, branch: info.branch }, 'PR created');

  return { prUrl, prNumber, branch: info.branch };
}

export async function cleanupWorktree(info: WorktreeInfo): Promise<void> {
  try {
    execSync(`git worktree remove ${JSON.stringify(info.worktreePath)}`, {
      cwd: info.repoPath,
      stdio: 'pipe',
      timeout: 15000,
    });
    logger.info(
      { id: info.id, worktreePath: info.worktreePath },
      'Worktree removed',
    );
  } catch (err) {
    logger.warn(
      { id: info.id, err },
      'Failed to remove worktree, may need manual cleanup',
    );
  }
}

// --- Meridian context ---

export function loadMeridianContext(repoPath: string): string {
  const parts: string[] = [];

  // Read .claude/state.md from the repo
  const stateFile = path.join(repoPath, '.claude', 'state.md');
  if (fs.existsSync(stateFile)) {
    try {
      parts.push(`## Repo State\n${fs.readFileSync(stateFile, 'utf-8')}`);
    } catch {
      /* ignore read errors */
    }
  }

  // Read .claude/team-state.md
  const teamStateFile = path.join(repoPath, '.claude', 'team-state.md');
  if (fs.existsSync(teamStateFile)) {
    try {
      parts.push(`## Team State\n${fs.readFileSync(teamStateFile, 'utf-8')}`);
    } catch {
      /* ignore */
    }
  }

  return parts.join('\n\n');
}

export async function writeMeridianJournal(entry: JournalEntry): Promise<void> {
  const homeDir = process.env.HOME || os.homedir();
  const today = new Date().toISOString().split('T')[0];
  const journalDir = path.join(homeDir, '.claude', 'memory', 'journal');
  const journalFile = path.join(journalDir, `${today}.md`);

  fs.mkdirSync(journalDir, { recursive: true });

  const content = `
## ${entry.repo} — ${entry.title}
**Why:** ${entry.why}
**What:** ${entry.what}
**Outcome:** ${entry.outcome}
**On track?:** Automated coding task
**Lessons:** —
`;

  fs.appendFileSync(journalFile, content);
  logger.info({ journalFile }, 'Journal entry written');
}

// --- Startup orphan detection ---

export function checkOrphanedWorktrees(): void {
  if (!fs.existsSync(WORKTREES_DIR)) return;

  const entries = fs.readdirSync(WORKTREES_DIR);
  if (entries.length > 0) {
    logger.warn(
      { count: entries.length, worktrees: entries },
      'Found orphaned worktrees from previous runs. Inspect data/worktrees/ and clean up manually.',
    );
  }
}

// --- PR body template ---

export function buildPrBody(opts: {
  owner: string;
  channel: string;
  branch: string;
  description: string;
  agentSummary?: string;
}): string {
  return `## NanoClaw Coding Task

**Owner:** ${opts.owner}
**Requested via:** Slack (${opts.channel})
**Branch:** ${opts.branch}

### Task
${opts.description}

### Changes
${opts.agentSummary || '_Agent did not provide a summary._'}`;
}

// --- Coding task prompt ---

export function buildCodingPrompt(opts: {
  repoName: string;
  branch: string;
  description: string;
  meridianContext: string;
}): string {
  const parts: string[] = [];

  if (opts.meridianContext) {
    parts.push(`<context>\n${opts.meridianContext}\n</context>`);
  }

  parts.push(`<coding-task>
You are working on branch "${opts.branch}" in repo "${opts.repoName}".
The repo is mounted at /workspace/code (read-write).

Your task: ${opts.description}

Instructions:
1. Read the relevant code to understand the codebase
2. Make the necessary changes
3. Commit your changes with clear, descriptive commit messages
4. After completing the work, write a brief summary of what you changed as your final response

Do NOT push or create PRs — that is handled by the host after you exit.
</coding-task>`);

  return parts.join('\n\n');
}
