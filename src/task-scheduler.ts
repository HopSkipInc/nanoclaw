import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  NANOCLAW_OWNER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  buildCodingPrompt,
  buildPrBody,
  cleanupWorktree,
  createWorktree,
  finalizeCodingTask,
  loadTeamContext,
  patchWorktreeForContainer,
  resolveRepo,
  writeJournal,
} from './coding-task.js';
import {
  CodingTaskMount,
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * Resolve the RegisteredGroup for a task. Returns null and logs on failure.
 */
function resolveTaskGroup(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): { group: RegisteredGroup; groupDir: string } | null {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: 0,
      status: 'error',
      result: null,
      error,
    });
    return null;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: 0,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return null;
  }

  return { group, groupDir };
}

/**
 * Run a scheduled coding task: worktree → agent → commit → push → PR.
 */
async function runCodingTask(
  task: ScheduledTask,
  group: RegisteredGroup,
  deps: SchedulerDependencies,
): Promise<{ result: string | null; error: string | null }> {
  const repoName = task.repo!;
  const description = task.prompt;

  const reply = async (text: string) => {
    await deps.sendMessage(task.chat_jid, text);
  };

  const repo = resolveRepo(repoName);
  if (!repo) {
    const error = `Repo "${repoName}" not found or not allowed. Check ~/.config/nanoclaw/repo-registry.json`;
    await reply(error);
    return { result: null, error };
  }

  let worktreeInfo;
  try {
    worktreeInfo = await createWorktree(repo, NANOCLAW_OWNER, description);
  } catch (err) {
    const error = `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`;
    await reply(error);
    return { result: null, error };
  }

  await reply(
    `Working on *${repoName}*: ${description}\nBranch: \`${worktreeInfo.branch}\``,
  );

  const teamContext = loadTeamContext(worktreeInfo.repoPath);
  const codingPrompt = buildCodingPrompt({
    repoName: worktreeInfo.repoName,
    branch: worktreeInfo.branch,
    description,
    teamContext,
  });

  const restoreGitPaths = patchWorktreeForContainer(worktreeInfo);
  const isMain = group.isMain === true;

  const codingMount: CodingTaskMount = {
    worktreePath: worktreeInfo.worktreePath,
    repoGitDir: worktreeInfo.repoGitDir,
    repoName: worktreeInfo.repoName,
    branch: worktreeInfo.branch,
    teamContext,
  };

  let agentSummary = '';
  let agentError: string | null = null;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: codingPrompt,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        codingTask: codingMount,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          const raw =
            typeof streamedOutput.result === 'string'
              ? streamedOutput.result
              : JSON.stringify(streamedOutput.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            agentSummary = text;
          }
        }
        if (streamedOutput.status === 'error') {
          agentError = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (output.status === 'error') {
      agentError = output.error || 'Unknown error';
    }
  } finally {
    restoreGitPaths();
  }

  if (agentError) {
    await reply(
      `Coding task failed. The agent encountered an error while working on this.`,
    );
    return { result: null, error: agentError };
  }

  // Finalize: push + PR
  await reply('Pushing branch and creating PR...');
  try {
    const channelName = group.name || task.chat_jid;
    const prBody = buildPrBody({
      owner: NANOCLAW_OWNER,
      channel: channelName,
      branch: worktreeInfo.branch,
      description,
      agentSummary,
    });

    const prResult = await finalizeCodingTask(
      worktreeInfo,
      `${description.slice(0, 65)}`,
      prBody,
    );

    const parts: string[] = [];
    if (agentSummary) parts.push(agentSummary);
    parts.push(`PR: ${prResult.prUrl}`);
    await reply(parts.join('\n\n'));

    await cleanupWorktree(worktreeInfo);

    await writeJournal({
      repo: worktreeInfo.repoName,
      title: description.slice(0, 80),
      why: `Scheduled coding task`,
      what: agentSummary.slice(0, 200) || description,
      outcome: `PR #${prResult.prNumber} created`,
    });

    return {
      result: `PR #${prResult.prNumber}: ${prResult.prUrl}`,
      error: null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await reply(
      `Agent completed the work but PR creation failed: ${error}\nThe worktree is preserved for manual recovery.`,
    );
    return { result: null, error };
  }
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();

  const resolved = resolveTaskGroup(task, deps);
  if (!resolved) return;
  const { group } = resolved;

  logger.info(
    { taskId: task.id, group: task.group_folder, repo: task.repo },
    'Running scheduled task',
  );

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // Route: coding task (has repo) vs normal task
  if (task.repo) {
    const codingResult = await runCodingTask(task, group, deps);
    result = codingResult.result;
    error = codingResult.error;
  } else {
    // Normal task flow (unchanged)
    const sessions = deps.getSessions();
    const sessionId =
      task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

    const TASK_CLOSE_DELAY_MS = 10000;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleClose = () => {
      if (closeTimer) return;
      closeTimer = setTimeout(() => {
        logger.debug(
          { taskId: task.id },
          'Closing task container after result',
        );
        deps.queue.closeStdin(task.chat_jid);
      }, TASK_CLOSE_DELAY_MS);
    };

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt: task.prompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.result) {
            result = streamedOutput.result;
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
            scheduleClose();
          }
          if (streamedOutput.status === 'success') {
            deps.queue.notifyIdle(task.chat_jid);
            scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
          }
          if (streamedOutput.status === 'error') {
            error = streamedOutput.error || 'Unknown error';
          }
        },
      );

      if (closeTimer) clearTimeout(closeTimer);

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else if (output.result) {
        result = output.result;
      }

      logger.info(
        { taskId: task.id, durationMs: Date.now() - startTime },
        'Task completed',
      );
    } catch (err) {
      if (closeTimer) clearTimeout(closeTimer);
      error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error }, 'Task failed');
    }
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
