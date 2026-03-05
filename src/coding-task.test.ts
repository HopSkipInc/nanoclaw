import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _resetRegistryCache,
  buildCodingPrompt,
  buildPrBody,
  checkOrphanedWorktrees,
  cleanupWorktree,
  createWorktree,
  loadMeridianContext,
  loadRepoRegistry,
  resolveRepo,
  WorktreeInfo,
} from './coding-task.js';

// Helper to create a temporary git repo for testing
function createTempRepo(defaultBranch = 'main'): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-repo-'));
  execSync(`git init -b ${defaultBranch}`, { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@test"', { cwd: tmpDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n');
  execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  return tmpDir;
}

function createBareRemote(sourceRepo: string): string {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-bare-'));
  execSync(
    `git clone --bare ${JSON.stringify(sourceRepo)} ${JSON.stringify(bareDir)}`,
    { stdio: 'pipe' },
  );
  // git init repos have no remote; add one pointing to the bare clone
  try {
    execSync(`git remote add origin ${JSON.stringify(bareDir)}`, {
      cwd: sourceRepo,
      stdio: 'pipe',
    });
  } catch {
    execSync(`git remote set-url origin ${JSON.stringify(bareDir)}`, {
      cwd: sourceRepo,
      stdio: 'pipe',
    });
  }
  execSync('git fetch origin', { cwd: sourceRepo, stdio: 'pipe' });
  return bareDir;
}

describe('coding-task', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    _resetRegistryCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetRegistryCache();
  });

  describe('loadRepoRegistry', () => {
    it('returns null when registry file does not exist', () => {
      _resetRegistryCache('/nonexistent/path/registry.json');
      const registry = loadRepoRegistry();
      expect(registry).toBeNull();
    });

    it('loads and caches registry from file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
      const registryFile = path.join(tmpDir, 'repo-registry.json');
      fs.writeFileSync(
        registryFile,
        JSON.stringify({
          repos: {
            TestRepo: {
              path: '/tmp/test',
              defaultBranch: 'main',
              allowed: true,
            },
          },
        }),
      );
      _resetRegistryCache(registryFile);

      const registry = loadRepoRegistry();
      expect(registry).not.toBeNull();
      expect(registry!.repos.TestRepo).toBeDefined();
      expect(registry!.repos.TestRepo.defaultBranch).toBe('main');

      // Second call should return cached
      const registry2 = loadRepoRegistry();
      expect(registry2).toBe(registry);

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('resolveRepo', () => {
    it('returns null for unknown repo', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
      const registryFile = path.join(tmpDir, 'repo-registry.json');
      fs.writeFileSync(registryFile, JSON.stringify({ repos: {} }));
      _resetRegistryCache(registryFile);

      expect(resolveRepo('NonExistent')).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('resolves repo case-insensitively', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
      const registryFile = path.join(tmpDir, 'repo-registry.json');
      fs.writeFileSync(
        registryFile,
        JSON.stringify({
          repos: {
            MyRepo: {
              path: tmpDir,
              defaultBranch: 'main',
              allowed: true,
            },
          },
        }),
      );
      _resetRegistryCache(registryFile);

      const result = resolveRepo('myrepo');
      expect(result).not.toBeNull();
      expect(result!.defaultBranch).toBe('main');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('returns null for disallowed repos', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
      const registryFile = path.join(tmpDir, 'repo-registry.json');
      fs.writeFileSync(
        registryFile,
        JSON.stringify({
          repos: {
            Blocked: {
              path: '/tmp/blocked',
              defaultBranch: 'main',
              allowed: false,
            },
          },
        }),
      );
      _resetRegistryCache(registryFile);

      expect(resolveRepo('Blocked')).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('createWorktree', () => {
    it('creates worktree with correct branch naming', async () => {
      const repoDir = createTempRepo();
      const bareDir = createBareRemote(repoDir);

      const repo = { path: repoDir, defaultBranch: 'main', allowed: true };
      const info = await createWorktree(repo, 'greg', 'fix the readme typo');

      expect(info.branch).toBe('nanoclaw/greg/fix-the-readme-typo');
      expect(fs.existsSync(info.worktreePath)).toBe(true);
      expect(info.repoPath).toBe(repoDir);

      // Verify git identity was set
      const name = execSync('git config user.name', {
        cwd: info.worktreePath,
        encoding: 'utf-8',
      }).trim();
      expect(name).toBe('NanoClaw (greg)');

      // Clean up
      await cleanupWorktree(info);
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('cleanupWorktree', () => {
    it('removes worktree', async () => {
      const repoDir = createTempRepo();
      const bareDir = createBareRemote(repoDir);

      const repo = { path: repoDir, defaultBranch: 'main', allowed: true };
      const info = await createWorktree(repo, 'test', 'cleanup test');

      expect(fs.existsSync(info.worktreePath)).toBe(true);
      await cleanupWorktree(info);
      expect(fs.existsSync(info.worktreePath)).toBe(false);

      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('loadMeridianContext', () => {
    it('reads state files when present', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'state.md'), '# State\nSome state');

      const context = loadMeridianContext(tmpDir);
      expect(context).toContain('Some state');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('returns empty string for missing files', () => {
      const context = loadMeridianContext('/nonexistent/path');
      expect(context).toBe('');
    });
  });

  describe('buildPrBody', () => {
    it('generates PR body with all fields', () => {
      const body = buildPrBody({
        owner: 'greg',
        channel: 'test-channel',
        branch: 'nanoclaw/greg/fix-typo',
        description: 'Fix the README typo',
        agentSummary: 'Fixed typo in line 5',
      });

      expect(body).toContain('greg');
      expect(body).toContain('test-channel');
      expect(body).toContain('nanoclaw/greg/fix-typo');
      expect(body).toContain('Fix the README typo');
      expect(body).toContain('Fixed typo in line 5');
    });

    it('handles missing agent summary', () => {
      const body = buildPrBody({
        owner: 'greg',
        channel: 'test',
        branch: 'branch',
        description: 'desc',
      });
      expect(body).toContain('did not provide a summary');
    });
  });

  describe('buildCodingPrompt', () => {
    it('includes task description and branch', () => {
      const prompt = buildCodingPrompt({
        repoName: 'TestRepo',
        branch: 'nanoclaw/greg/test',
        description: 'Add a new feature',
        meridianContext: '',
      });

      expect(prompt).toContain('nanoclaw/greg/test');
      expect(prompt).toContain('TestRepo');
      expect(prompt).toContain('Add a new feature');
      expect(prompt).toContain('/workspace/code');
    });

    it('includes meridian context when provided', () => {
      const prompt = buildCodingPrompt({
        repoName: 'TestRepo',
        branch: 'branch',
        description: 'desc',
        meridianContext: '## Repo State\nSome context here',
      });

      expect(prompt).toContain('Some context here');
      expect(prompt).toContain('<context>');
    });
  });

  describe('checkOrphanedWorktrees', () => {
    it('does not throw when worktrees dir does not exist', () => {
      expect(() => checkOrphanedWorktrees()).not.toThrow();
    });
  });
});
