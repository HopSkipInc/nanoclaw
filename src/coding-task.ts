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
  repoGitDir: string; // absolute path to <repo>/.git
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

  // Clean up any leftover branch/worktree from a previous attempt with the
  // same slug (common when retrying the same task description).
  try {
    const existing = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10000,
    });
    // Find worktree using this branch and remove it first
    const branchPattern = `branch refs/heads/${branch}`;
    if (existing.includes(branchPattern)) {
      const lines = existing.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === branchPattern && i >= 2) {
          const wtPath = lines[i - 2].replace('worktree ', '');
          if (wtPath && wtPath !== repoPath) {
            execSync(`git worktree remove ${JSON.stringify(wtPath)} --force`, {
              cwd: repoPath,
              stdio: 'pipe',
              timeout: 10000,
            });
            logger.info({ wtPath, branch }, 'Removed stale worktree');
          }
        }
      }
    }
    // Delete the branch if it still exists
    execSync(`git branch -D ${JSON.stringify(branch)}`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.info({ branch }, 'Deleted existing branch for retry');
  } catch {
    // Branch doesn't exist — normal case, continue
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

  // Resolve the repo's .git directory (usually <repoPath>/.git)
  const repoGitDir = path.join(repoPath, '.git');

  logger.info({ id, branch, worktreePath, repoPath }, 'Worktree created');

  return {
    id,
    worktreePath,
    branch,
    repoName: path.basename(repoPath),
    repoPath,
    repoGitDir,
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

  // Create PR via gh CLI.
  // Write body to a temp file to preserve markdown formatting (newlines,
  // headers, etc.) — shell escaping via JSON.stringify turns \n into literals.
  const bodyFile = path.join(info.worktreePath, '.nanoclaw-pr-body.md');
  fs.writeFileSync(bodyFile, body);
  let prOutput: string;
  try {
    prOutput = execSync(
      `gh pr create --title ${JSON.stringify(title)} --body-file ${JSON.stringify(bodyFile)} --base ${info.defaultBranch} --head ${info.branch}`,
      { cwd: info.worktreePath, encoding: 'utf-8', timeout: 30000 },
    ).trim();
  } finally {
    try {
      fs.unlinkSync(bodyFile);
    } catch {
      /* ignore cleanup errors */
    }
  }

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

// Container path where repo .git dir is mounted
const CONTAINER_REPO_GIT = '/workspace/repo-git';
const CONTAINER_WORKTREE = '/workspace/code';

/**
 * Rewrite git path references so the worktree works inside the container.
 * Returns a restore function that reverts the changes (call after container exits).
 */
export function patchWorktreeForContainer(info: WorktreeInfo): () => void {
  const worktreeGitFile = path.join(info.worktreePath, '.git');
  const metadataGitdirFile = path.join(
    info.repoGitDir,
    'worktrees',
    info.id,
    'gitdir',
  );

  // Save originals
  const origWorktreeGit = fs.readFileSync(worktreeGitFile, 'utf-8');
  const origMetadataGitdir = fs.readFileSync(metadataGitdirFile, 'utf-8');

  // Patch: worktree .git → container-side worktree metadata path
  fs.writeFileSync(
    worktreeGitFile,
    `gitdir: ${CONTAINER_REPO_GIT}/worktrees/${info.id}\n`,
  );

  // Patch: metadata gitdir → container-side worktree .git path
  fs.writeFileSync(metadataGitdirFile, `${CONTAINER_WORKTREE}/.git\n`);

  logger.debug({ id: info.id }, 'Patched worktree git paths for container');

  return () => {
    fs.writeFileSync(worktreeGitFile, origWorktreeGit);
    fs.writeFileSync(metadataGitdirFile, origMetadataGitdir);
    logger.debug({ id: info.id }, 'Restored worktree git paths');
  };
}

// --- Team context (Wayfind protocol) ---

function readFileIfExists(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    /* ignore read errors */
  }
  return null;
}

/**
 * Extract the User Preferences section from global-state.md.
 * Returns just the preferences block, not the full file (which has
 * active projects, memory manifest, etc. that aren't relevant to coding).
 */
function extractUserPreferences(globalState: string): string | null {
  const prefStart = globalState.indexOf('## User Preferences');
  if (prefStart === -1) return null;
  const nextSection = globalState.indexOf('\n## ', prefStart + 1);
  return globalState
    .slice(prefStart, nextSection === -1 ? undefined : nextSection)
    .trim();
}

/**
 * Scan the Memory Files table in global-state.md and return paths to files
 * whose "When to load" keywords match the target repo name.
 */
function findRelevantMemoryFiles(
  globalState: string,
  repoName: string,
): string[] {
  const homeDir = process.env.HOME || os.homedir();
  const memoryDir = path.join(homeDir, '.claude', 'memory');
  const matches: string[] = [];
  const repoLower = repoName.toLowerCase();

  // Parse the memory files table — rows like: | `file.md` | keywords | summary |
  const tableRegex = /^\|\s*`([^`]+)`\s*\|([^|]+)\|/gm;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(globalState)) !== null) {
    const fileName = match[1];
    const keywords = match[2].toLowerCase();
    if (keywords.includes(repoLower)) {
      const filePath = path.join(memoryDir, fileName);
      if (fs.existsSync(filePath)) {
        matches.push(filePath);
      }
    }
  }

  return matches;
}

/**
 * Load full team context for a coding task (Wayfind protocol).
 *
 * Gathers:
 * 1. Global user instructions (~/.claude/CLAUDE.md, ~/CLAUDE.md)
 * 2. User preferences from global-state.md
 * 3. Relevant cross-repo memory files
 * 4. Target repo's CLAUDE.md, state, team-state, personal-state
 */
export function loadTeamContext(repoPath: string): string {
  const homeDir = process.env.HOME || os.homedir();
  const parts: string[] = [];

  // --- Global context (user-level) ---

  // Global CLAUDE.md files — user's universal coding instructions
  const globalClaudeMd = readFileIfExists(
    path.join(homeDir, '.claude', 'CLAUDE.md'),
  );
  if (globalClaudeMd) {
    parts.push(`## Global Instructions (~/.claude/CLAUDE.md)\n${globalClaudeMd}`);
  }

  const homeClaudeMd = readFileIfExists(path.join(homeDir, 'CLAUDE.md'));
  if (homeClaudeMd) {
    parts.push(`## Global Instructions (~/CLAUDE.md)\n${homeClaudeMd}`);
  }

  // User preferences from global-state.md
  const globalState = readFileIfExists(
    path.join(homeDir, '.claude', 'global-state.md'),
  );
  if (globalState) {
    const prefs = extractUserPreferences(globalState);
    if (prefs) {
      parts.push(prefs);
    }

    // Cross-repo memory files relevant to this repo
    const repoName = path.basename(repoPath);
    const memoryFiles = findRelevantMemoryFiles(globalState, repoName);
    for (const memFile of memoryFiles) {
      const content = readFileIfExists(memFile);
      if (content) {
        const fileName = path.basename(memFile);
        parts.push(`## Memory: ${fileName}\n${content}`);
      }
    }
  }

  // --- Repo-level context ---

  // Read the repo's CLAUDE.md — contains project conventions, key files,
  // development instructions. The agent's CWD is /workspace/group (not
  // /workspace/code), so the SDK won't auto-load this from the worktree.
  const claudeMdContent = readFileIfExists(path.join(repoPath, 'CLAUDE.md'));
  if (claudeMdContent) {
    parts.push(`## Project Instructions (CLAUDE.md)\n${claudeMdContent}`);
  }

  // Repo state files
  const stateContent = readFileIfExists(
    path.join(repoPath, '.claude', 'state.md'),
  );
  if (stateContent) {
    parts.push(`## Repo State\n${stateContent}`);
  }

  const teamStateContent = readFileIfExists(
    path.join(repoPath, '.claude', 'team-state.md'),
  );
  if (teamStateContent) {
    parts.push(`## Team State\n${teamStateContent}`);
  }

  const personalStateContent = readFileIfExists(
    path.join(repoPath, '.claude', 'personal-state.md'),
  );
  if (personalStateContent) {
    parts.push(`## Personal Context\n${personalStateContent}`);
  }

  return parts.join('\n\n');
}

export async function writeJournal(entry: JournalEntry): Promise<void> {
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
  teamContext: string;
}): string {
  const parts: string[] = [];

  if (opts.teamContext) {
    parts.push(`<context>\n${opts.teamContext}\n</context>`);
  }

  parts.push(`<coding-task>
You are working on branch "${opts.branch}" in repo "${opts.repoName}".
The repo is mounted at /workspace/code (read-write).

Your task: ${opts.description}

Instructions:
1. Read the repo's CLAUDE.md and any relevant docs FIRST to understand project conventions
2. Read the relevant source code to understand the codebase before making changes
3. Follow the coding patterns and conventions already established in the repo
4. Run existing tests after your changes to verify nothing is broken
5. If the repo has a build step, verify the build passes
6. Commit your changes with clear, descriptive commit messages (imperative mood, explain "why" not "what")
7. Write a brief summary of what you changed and why as your final response

Do NOT push or create PRs — that is handled by the host after you exit.
Do NOT create new documentation files unless the task specifically asks for it.
</coding-task>`);

  return parts.join('\n\n');
}
