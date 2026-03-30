import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  NANOCLAW_OWNER,
  POLL_INTERVAL,
  SLACK_ONLY,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  buildCodingPrompt,
  buildPrBody,
  checkOrphanedWorktrees,
  cleanupWorktree,
  createWorktree,
  finalizeCodingTask,
  loadRepoRegistry,
  loadTeamContext,
  patchWorktreeForContainer,
  resolveRepo,
  writeJournal,
} from './coding-task.js';
import {
  buildFleetPrBody,
  cleanupAciFleetTask,
  cleanupFleetTask,
  FleetTaskConfig,
  parseFleetTask,
  readFleetPrUrl,
  readFleetStatus,
  setupFleetTask,
  writeFleetJournal,
} from './fleet-task.js';
import { startFleetProgressRelay } from './fleet-progress.js';
import { parseWorkItem } from './work-item-parser.js';
import {
  fetchWorkItemContext,
  formatGoal,
  suggestAgents,
} from './work-item-context.js';
import {
  enqueueFleetWork,
  buildFleetWorkMessage,
  clearQueue,
  peekQueue,
} from './fleet-queue.js';
import { startDispatcher, registerReplyHandler } from './fleet-dispatcher.js';
import { startHealthServer, setHealthState, setNotReady } from './health.js';
import {
  classifyIntent,
  confirmationMessage,
  routingDecision,
  ClassifiedIntent,
} from './intent-classifier.js';
import { handleProspectBotMessage } from './prospectbot-handler.js';
import {
  CodingTaskMount,
  ContainerInput,
  ContainerOutput,
  RepoMount,
  runContainerAgent,
  writeGroupsSnapshot,
  writeRepoRegistrySnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Pending intent confirmations — keyed by chatJid
// When a medium-confidence classification is sent, we store it here.
// The next message in the same chat is checked for approval.
interface PendingConfirmation {
  classification: ClassifiedIntent;
  timestamp: number; // expires after 5 minutes
  triggerMessageId?: string;
}
const pendingConfirmations: Record<string, PendingConfirmation> = {};
const CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/** Get the trigger pattern for a specific group, falling back to global. */
function getGroupTriggerPattern(chatJid: string): RegExp {
  const group = registeredGroups[chatJid];
  if (group?.trigger) {
    return new RegExp(group.trigger, 'i');
  }
  return TRIGGER_PATTERN;
}

/** Get the bot display name for a group based on its channel instance. */
function getGroupBotName(chatJid: string): string {
  const group = registeredGroups[chatJid];
  if (group?.channel_id) {
    const channel = channels.find((c) => c.name === group.channel_id);
    if (channel && 'botDisplayName' in channel) {
      return (channel as { botDisplayName: string }).botDisplayName;
    }
  }
  return ASSISTANT_NAME;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid, group.channel_id);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.isMain === true;
  const triggerPattern = getGroupTriggerPattern(chatJid);

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    getGroupBotName(chatJid),
  );

  if (missedMessages.length === 0) return true;

  // ProspectBot handler — direct API, no containers
  if (group.folder === 'prospectbot') {
    const latestMessage = missedMessages[missedMessages.length - 1];
    const messageText = latestMessage.content
      .replace(triggerPattern, '')
      .trim();
    const triggerMessageId = latestMessage.thread_ts || latestMessage.id;
    try {
      const response = await handleProspectBotMessage(
        messageText,
        chatJid,
        triggerMessageId,
      );
      if (triggerMessageId && channel.sendThreadReply) {
        await channel.sendThreadReply(chatJid, response, triggerMessageId);
      } else {
        await channel.sendMessage(chatJid, response);
      }
    } catch (err) {
      logger.error({ err, chatJid }, 'ProspectBot handler error');
      const errorText = 'SDR Bot API is unavailable, try again later.';
      if (triggerMessageId && channel.sendThreadReply) {
        await channel.sendThreadReply(chatJid, errorText, triggerMessageId);
      } else {
        await channel.sendMessage(chatJid, errorText);
      }
    }
    lastAgentTimestamp[chatJid] = latestMessage.timestamp;
    saveState();
    return true;
  }

  // Check for pending confirmation approval
  const pending = pendingConfirmations[chatJid];
  if (pending) {
    delete pendingConfirmations[chatJid];
    const elapsed = Date.now() - pending.timestamp;
    if (elapsed < CONFIRMATION_TIMEOUT_MS) {
      const latestContent = missedMessages[missedMessages.length - 1].content
        .toLowerCase()
        .trim();
      const isApproval =
        /^(yes|yeah|yep|y|go|go ahead|do it|sure|ok|launch|start|fix it|ship it)\b/i.test(
          latestContent,
        );
      if (isApproval) {
        const c = pending.classification;
        lastAgentTimestamp[chatJid] =
          missedMessages[missedMessages.length - 1].timestamp;
        saveState();
        if (c.intent === 'estimate') {
          await processEstimateTask(
            chatJid,
            channel,
            group,
            c.repo!,
            c.description,
            pending.triggerMessageId,
          );
        } else if (c.intent === 'fleet') {
          const fleetConfig = parseFleetTask(
            `fleet ${c.repo} ${c.description}`,
          );
          if (fleetConfig) {
            await processFleetTask(
              chatJid,
              channel,
              group,
              fleetConfig,
              pending.triggerMessageId,
            );
          }
        } else {
          // Default: code
          await processCodingTask(
            chatJid,
            channel,
            group,
            c.repo!,
            c.description,
            pending.triggerMessageId,
          );
        }
        return true;
      }
      // Not an approval — fall through to normal processing
    } else {
      logger.info(
        {
          elapsed: Math.round(elapsed / 1000),
          intent: pending.classification.intent,
        },
        'Pending confirmation expired',
      );
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Check if the latest trigger message is a coding task or fleet task
  const triggerMessage = missedMessages.find((m) =>
    triggerPattern.test(m.content.trim()),
  );
  if (triggerMessage) {
    // --- Admin commands (no container, instant reply) ---
    const adminResult = await handleAdminCommand(
      triggerMessage.content,
      triggerPattern,
      chatJid,
      channel,
    );
    if (adminResult) {
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      return true;
    }

    const codingTask = parseCodingTask(triggerMessage.content, triggerPattern);
    if (codingTask) {
      // Advance cursor before async coding task
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      await processCodingTask(
        chatJid,
        channel,
        group,
        codingTask.repoName,
        codingTask.description,
        triggerMessage.id,
      );
      return true;
    }

    const fleetTask = parseFleetTask(triggerMessage.content);
    if (fleetTask) {
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      await processFleetTask(
        chatJid,
        channel,
        group,
        fleetTask,
        triggerMessage.id,
      );
      return true;
    }

    const estimateTask = parseEstimateTask(
      triggerMessage.content,
      triggerPattern,
    );
    if (estimateTask) {
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      await processEstimateTask(
        chatJid,
        channel,
        group,
        estimateTask.repoName,
        estimateTask.description,
        triggerMessage.id,
      );
      return true;
    }
  }

  // Natural language intent classification (runs when regex parsers don't match)
  // Only for trigger messages — don't classify random conversation
  if (triggerMessage) {
    const stripped = triggerMessage.content
      .replace(triggerPattern, '')
      .replace(/<@[A-Z0-9]+>/g, '')
      .trim();
    const classification = await classifyIntent(stripped);
    if (classification) {
      const decision = routingDecision(classification);
      if (decision === 'direct' && classification.repo) {
        lastAgentTimestamp[chatJid] =
          missedMessages[missedMessages.length - 1].timestamp;
        saveState();
        if (classification.intent === 'estimate') {
          await processEstimateTask(
            chatJid,
            channel,
            group,
            classification.repo,
            classification.description,
            triggerMessage.id,
          );
        } else if (classification.intent === 'fleet') {
          const fleetConfig = parseFleetTask(
            `fleet ${classification.repo} ${classification.description}`,
          );
          if (fleetConfig) {
            await processFleetTask(
              chatJid,
              channel,
              group,
              fleetConfig,
              triggerMessage.id,
            );
          }
        } else {
          await processCodingTask(
            chatJid,
            channel,
            group,
            classification.repo,
            classification.description,
            triggerMessage.id,
          );
        }
        return true;
      }
      if (decision === 'confirm') {
        // Store pending confirmation and ask the user
        pendingConfirmations[chatJid] = {
          classification,
          timestamp: Date.now(),
          triggerMessageId: triggerMessage.id,
        };
        lastAgentTimestamp[chatJid] =
          missedMessages[missedMessages.length - 1].timestamp;
        saveState();
        const msg = confirmationMessage(classification);
        if (triggerMessage.id && channel.sendThreadReply) {
          await channel.sendThreadReply(chatJid, msg, triggerMessage.id);
        } else {
          await channel.sendMessage(chatJid, msg);
        }
        return true;
      }
      // decision === 'chat' — fall through to regular agent
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  codingTask?: CodingTaskMount,
  fleetTask?: ContainerInput['fleetTask'],
  repoMount?: RepoMount,
): Promise<'success' | 'error'> {
  // Guard: Container App host has no Docker — can only handle fleet/code/estimate via ACI queue
  if (
    process.env.CONTAINER_APP_NAME &&
    !codingTask &&
    !fleetTask &&
    !repoMount
  ) {
    const channel = findChannel(channels, chatJid, group.channel_id);
    if (channel) {
      await channel.sendMessage(
        chatJid,
        "I'm running in cloud mode — I can handle `fleet`, `code`, and `estimate` commands but can't chat. Try: `@FleetBot fleet <repo> <description>` or `@FleetBot estimate <repo> <description>`",
      );
    }
    return 'success';
  }

  const isMain = group.isMain === true;
  // Coding/fleet tasks get a fresh session — no conversation history carryover
  // Repo mount sessions (estimates) DO persist for interactive follow-ups
  const sessionId =
    codingTask || fleetTask ? undefined : sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update repo registry snapshot so container knows available repos
  const registry = loadRepoRegistry();
  if (registry) {
    writeRepoRegistrySnapshot(group.folder, isMain, registry.repos);
  }

  // Wrap onOutput to track session ID from streamed results
  // Coding/fleet tasks use throwaway sessions — don't persist their IDs
  const isThrowawaySession = !!(codingTask || fleetTask);
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && !isThrowawaySession) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        codingTask,
        fleetTask,
        repoMount,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId && !isThrowawaySession) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

// Pattern: "@NanoClaw code <repo> <description>"
const CODING_TASK_PATTERN = /^code\s+(\S+)\s+(.+)$/i;

// Pattern: "@NanoClaw estimate <repo> <description>"
const ESTIMATE_TASK_PATTERN = /^estimate\s+(\S+)\s+(.+)$/i;

/**
 * Detect if a message is a coding task request.
 * Returns { repoName, description } or null.
 * Only matches if the repo name exists in the registry (otherwise falls through to NL classifier).
 */
function parseCodingTask(
  content: string,
  trigger: RegExp = TRIGGER_PATTERN,
): { repoName: string; description: string } | null {
  // Strip the trigger prefix (e.g., "@NanoClaw ") and any Slack user mentions
  const stripped = content
    .replace(trigger, '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim();
  const match = stripped.match(CODING_TASK_PATTERN);
  if (!match) return null;
  // Validate repo exists — if not, return null so NL classifier can handle it
  const repo = resolveRepo(match[1]);
  if (!repo) return null;
  return { repoName: match[1], description: match[2] };
}

/**
 * Detect if a message is an estimate task request.
 * Returns { repoName, description } or null.
 * Only matches if the repo name exists in the registry.
 */
function parseEstimateTask(
  content: string,
  trigger: RegExp = TRIGGER_PATTERN,
): { repoName: string; description: string } | null {
  const stripped = content
    .replace(trigger, '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim();
  const match = stripped.match(ESTIMATE_TASK_PATTERN);
  if (!match) return null;
  const repo = resolveRepo(match[1]);
  if (!repo) return null;
  return { repoName: match[1], description: match[2] };
}

/**
 * Handle admin commands (queue clear, queue peek, etc.).
 * Returns true if the message was an admin command, false otherwise.
 */
async function handleAdminCommand(
  content: string,
  triggerPattern: RegExp,
  chatJid: string,
  channel: Channel,
): Promise<boolean> {
  const stripped = content
    .replace(triggerPattern, '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim()
    .toLowerCase();

  if (stripped === 'queue clear' || stripped === 'queue purge') {
    try {
      await clearQueue();
      await channel.sendMessage(chatJid, 'Fleet work queue cleared.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await channel.sendMessage(chatJid, `Failed to clear queue: ${msg}`);
    }
    return true;
  }

  if (stripped === 'queue peek' || stripped === 'queue status') {
    try {
      const messages = await peekQueue();
      if (messages.length === 0) {
        await channel.sendMessage(chatJid, 'Fleet work queue is empty.');
      } else {
        const lines = messages.map(
          (m, i) =>
            `${i + 1}. *${m.task.repoSlug}* — ${m.task.description.slice(0, 80)}${m.task.description.length > 80 ? '...' : ''} (${m.createdAt})`,
        );
        await channel.sendMessage(
          chatJid,
          `*Queue* (${messages.length} message${messages.length > 1 ? 's' : ''}):\n${lines.join('\n')}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await channel.sendMessage(chatJid, `Failed to peek queue: ${msg}`);
    }
    return true;
  }

  return false;
}

/**
 * Process a coding task: create worktree, run agent, push branch, create PR.
 */
async function processCodingTask(
  chatJid: string,
  channel: Channel,
  group: RegisteredGroup,
  repoName: string,
  description: string,
  triggerMessageId?: string,
): Promise<void> {
  // Reply in thread if the channel supports it, otherwise fall back to channel
  const reply = async (text: string) => {
    if (triggerMessageId && channel.sendThreadReply) {
      await channel.sendThreadReply(chatJid, text, triggerMessageId);
    } else {
      await channel.sendMessage(chatJid, text);
    }
  };

  const repo = resolveRepo(repoName);
  if (!repo) {
    await reply(
      `Repo "${repoName}" not found or not allowed. Check ~/.config/nanoclaw/repo-registry.json`,
    );
    return;
  }

  let worktreeInfo;
  try {
    worktreeInfo = await createWorktree(repo, NANOCLAW_OWNER, description);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(`Failed to create worktree: ${msg}`);
    return;
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

  // Patch git paths so the worktree works inside the container
  const restoreGitPaths = patchWorktreeForContainer(worktreeInfo);

  // Run the agent with the worktree mounted
  let agentSummary = '';
  let output: string;
  try {
    output = await runAgent(
      group,
      codingPrompt,
      chatJid,
      async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            agentSummary = text;
          }
        }
      },
      {
        worktreePath: worktreeInfo.worktreePath,
        repoGitDir: worktreeInfo.repoGitDir,
        repoName: worktreeInfo.repoName,
        branch: worktreeInfo.branch,
        teamContext,
      },
    );
  } finally {
    // Always restore host-side git paths, even on error
    restoreGitPaths();
  }

  if (output === 'error') {
    await reply(
      `Coding task failed. The agent encountered an error while working on this. You can retry by sending the same request again.`,
    );
    return;
  }

  // Finalize: push + PR
  await reply('Pushing branch and creating PR...');
  try {
    const channelName = group.name || chatJid;
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

    // Post agent summary + PR link as the final message
    const parts: string[] = [];
    if (agentSummary) parts.push(agentSummary);
    parts.push(`PR: ${prResult.prUrl}`);
    await reply(parts.join('\n\n'));

    // Clean up worktree after successful PR
    await cleanupWorktree(worktreeInfo);

    // Journal entry
    await writeJournal({
      repo: worktreeInfo.repoName,
      title: description.slice(0, 80),
      why: `Coding task requested via Slack`,
      what: agentSummary.slice(0, 200) || description,
      outcome: `PR #${prResult.prNumber} created`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(
      `Agent completed the work but PR creation failed: ${msg}\nAsk an admin to check the worktree or retry.`,
    );
  }
}

/**
 * Process a fleet task: create worktree, run multi-agent fleet, push branch, create PR.
 */
async function processFleetTask(
  chatJid: string,
  channel: Channel,
  group: RegisteredGroup,
  config: FleetTaskConfig,
  triggerMessageId?: string,
  estimateThreadRef?: string,
): Promise<void> {
  const reply = async (text: string) => {
    if (triggerMessageId && channel.sendThreadReply) {
      await channel.sendThreadReply(chatJid, text, triggerMessageId);
    } else {
      await channel.sendMessage(chatJid, text);
    }
  };

  // --- Enrich description with work item context ---
  // If the command referenced a work item (URL or shorthand), fetch its
  // full context and build a rich goal for the fleet agents.
  if (config.issueNumber) {
    try {
      const workItem =
        parseWorkItem(config.repoName + ' #' + config.issueNumber) ||
        parseWorkItem(
          config.repoName.replace('ado:', '') + ' ' + config.issueNumber,
        );
      if (workItem) {
        // TODO: tokens should come from KV in Azure, env vars for now
        const tokens = {
          githubToken: process.env.GITHUB_TOKEN,
          adoPat: process.env.ADO_PAT,
        };
        if (tokens.githubToken || tokens.adoPat) {
          const context = await fetchWorkItemContext(workItem, tokens);
          config = {
            ...config,
            description: formatGoal(context, config.description),
            agents: config.agents || suggestAgents(context),
          };
          await reply(
            `Fetched context: *${context.title}* (${context.typeHint})`,
          );
        }
      }
    } catch (err) {
      // Context fetch is best-effort — don't block the fleet
      logger.warn(
        { err, issueNumber: config.issueNumber },
        'Failed to fetch work item context',
      );
    }
  }

  // --- Queue-based dispatch (production) ---
  // When running in Azure, enqueue and return. The dispatcher loop handles
  // ACI creation, progress relay, and cleanup. This decouples intake from
  // execution so any trigger source (Slack, GitHub, Notion, ADO) can write
  // the same queue format.
  if (process.env.FLEET_USE_QUEUE === '1') {
    try {
      const queueMessage = buildFleetWorkMessage({
        repoSlug: config.repoName,
        description: config.description,
        issueNumber: config.issueNumber,
        branch: config.branch,
        agents: config.agents,
        timeoutMinutes: config.timeoutMinutes,
        modelStrategy: config.modelStrategy,
        target: config.target,
        teamContext: '',
        source: {
          type: 'slack',
          requester: NANOCLAW_OWNER,
          replyTo: triggerMessageId
            ? { type: 'slack', channelId: chatJid, threadTs: triggerMessageId }
            : { type: 'slack', channelId: chatJid },
        },
      });
      await enqueueFleetWork(queueMessage);
      await reply(
        `Fleet queued for *${config.repoName}*. The dispatcher will pick it up shortly.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply(`Failed to enqueue fleet: ${msg}`);
    }
    return;
  }

  // --- Direct dispatch (local dev) ---
  let setup;
  try {
    setup = await setupFleetTask(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(`Fleet setup failed: ${msg}`);
    return;
  }

  const agentList = config.agents || 'super,critic,eng1,eng2,qa1';

  // --- ACI dispatch path ---
  // Host is a thin dispatcher + Slack relay. Fleet container handles
  // clone, work, push, PR creation. See fleet-dispatch-architecture.md.
  if (setup.mode === 'azure') {
    const { aciResult } = setup;

    const startParts = [
      `Fleet dispatched to Azure on *${config.repoName}*: ${config.description}`,
      `Fleet ID: \`${aciResult.fleetId}\``,
      `Agents: ${agentList}`,
    ];
    if (estimateThreadRef) {
      startParts.push(
        `_Spawned from <${estimateThreadRef}|estimate conversation>_`,
      );
    }
    await reply(startParts.join('\n'));

    // Poll Azure Files for fleet status (same progress relay, different path)
    // The fleet-status share is mounted locally at a well-known path when the
    // host runs in Container Apps, or can be accessed via Azure Files REST API.
    const azureStatusDir = `/mnt/fleet-status/${aciResult.fleetId}`;
    const progressRelay = startFleetProgressRelay(azureStatusDir, reply);

    try {
      // Wait for terminal status (fleet-status.json status becomes terminal)
      await progressRelay.done;
    } finally {
      progressRelay.stop();
    }

    // Read final status — PR URL comes from the fleet (super agent created it)
    const finalStatus = readFleetStatus(azureStatusDir);
    if (
      finalStatus &&
      (finalStatus.status === 'success' || finalStatus.status === 'completed')
    ) {
      const parts: string[] = [];
      if (finalStatus.message) parts.push(finalStatus.message);
      // PR URL is written to fleet-status.json by fleet-complete
      const prUrl = readFleetPrUrl(azureStatusDir);
      if (prUrl) parts.push(`PR: ${prUrl}`);
      await reply(parts.join('\n\n'));
      await writeFleetJournal(
        config.repoName,
        config.description,
        finalStatus.message,
      );
    } else {
      const statusMsg = finalStatus
        ? `Fleet status: ${finalStatus.status} — ${finalStatus.message}`
        : 'Fleet did not report a final status.';
      await reply(`Fleet task failed. ${statusMsg}`);
    }

    // Clean up ACI container group
    try {
      await cleanupAciFleetTask(aciResult.containerGroupName);
    } catch (err) {
      logger.warn(
        { err, containerGroupName: aciResult.containerGroupName },
        'ACI cleanup failed',
      );
    }
    return;
  }

  // --- Local Docker path (existing behavior) ---
  const { worktreeInfo, fleetMount, restoreGitPaths } = setup;

  const startParts = [
    `Fleet starting on *${config.repoName}*: ${config.description}`,
    `Branch: \`${worktreeInfo.branch}\``,
    `Agents: ${agentList}`,
  ];
  if (estimateThreadRef) {
    startParts.push(
      `_Spawned from <${estimateThreadRef}|estimate conversation>_`,
    );
  }
  await reply(startParts.join('\n'));

  // Start progress relay — polls fleet status files and posts updates to Slack
  const progressRelay = startFleetProgressRelay(
    fleetMount.fleetStatusDir,
    reply,
  );

  // Run the fleet container
  let fleetResult = '';
  let output: string;
  try {
    output = await runAgent(
      group,
      '', // prompt is unused — fleet entrypoint reads from fleetTask input
      chatJid,
      async (result) => {
        if (result.result) {
          const text = (
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result)
          )
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            fleetResult = text;
            // Don't relay container output markers to Slack —
            // the progress relay handles all Slack updates
          }
        }
      },
      undefined, // no codingTask
      {
        ...fleetMount,
        description: config.description,
        agents: config.agents,
        timeoutMinutes: config.timeoutMinutes,
      },
    );
  } finally {
    restoreGitPaths();
    progressRelay.stop();
    await progressRelay.done;
  }

  if (output === 'error') {
    // Read fleet status for more context
    const status = readFleetStatus(fleetMount.fleetStatusDir);
    const statusMsg = status
      ? ` Fleet status: ${status.status} — ${status.message}`
      : '';
    await reply(`Fleet task failed.${statusMsg}`);
    // Clean up on failure
    await cleanupFleetTask(worktreeInfo, fleetMount.fleetStatusDir);
    return;
  }

  // Finalize: push + PR (same as coding tasks)
  await reply('Fleet complete. Pushing branch and creating PR...');
  try {
    const channelName = group.name || chatJid;
    const fleetStatus = readFleetStatus(fleetMount.fleetStatusDir);

    // Read the fleet summary written by the super agent
    let fleetSummaryBody = '';
    const summaryPath = path.join(
      worktreeInfo.worktreePath,
      '.fleet-summary.md',
    );
    try {
      if (fs.existsSync(summaryPath)) {
        fleetSummaryBody = fs.readFileSync(summaryPath, 'utf-8').trim();
      }
    } catch {
      /* summary file not available */
    }

    const prBody =
      fleetSummaryBody ||
      buildFleetPrBody({
        owner: NANOCLAW_OWNER,
        channel: channelName,
        branch: worktreeInfo.branch,
        description: config.description,
        fleetStatus: fleetStatus
          ? `${fleetStatus.status}: ${fleetStatus.message}`
          : fleetResult,
      });

    // Extract a PR title from the summary's first heading or first line
    let prTitle = config.description.slice(0, 65);
    if (fleetSummaryBody) {
      const headingMatch = fleetSummaryBody.match(/^##\s+Summary\s*\n+(.+)/m);
      if (headingMatch) {
        prTitle = headingMatch[1].trim().slice(0, 65);
      }
    }

    const prResult = await finalizeCodingTask(worktreeInfo, prTitle, prBody);

    const parts: string[] = [];
    if (fleetResult) parts.push(fleetResult);
    parts.push(`PR: ${prResult.prUrl}`);
    await reply(parts.join('\n\n'));

    await cleanupFleetTask(worktreeInfo, fleetMount.fleetStatusDir);
    await writeFleetJournal(
      worktreeInfo.repoName,
      config.description,
      `PR #${prResult.prNumber} created`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(
      `Fleet completed but PR creation failed: ${msg}\nCheck the worktree or retry.`,
    );
  }
}

/**
 * Build the prompt for an estimate task.
 * Loads the estimator template from ai-fleet if available.
 */
function buildEstimatePrompt(opts: {
  repoName: string;
  description: string;
  teamContext: string;
  chatJid: string;
  threadRef?: string;
}): string {
  const parts: string[] = [];

  if (opts.teamContext) {
    parts.push(`<context>\n${opts.teamContext}\n</context>`);
  }

  // Try to load estimator template from ai-fleet
  const homeDir = process.env.HOME || '/home/user';
  const aiFleetDir =
    process.env.AI_FLEET_DIR ||
    path.join(homeDir, 'repos', 'HopSkipInc', 'ai-fleet');
  const templatePath = path.join(
    aiFleetDir,
    'claude-md-templates',
    'base',
    'estimator.md',
  );

  let estimatorTemplate = '';
  try {
    if (fs.existsSync(templatePath)) {
      estimatorTemplate = fs.readFileSync(templatePath, 'utf-8');
    }
  } catch {
    /* template not available */
  }

  if (estimatorTemplate) {
    // Substitute template variables
    estimatorTemplate = estimatorTemplate
      .replace(/\{\{AGENT_NAME\}\}/g, 'estimator')
      .replace(/\{\{REPO_PATH\}\}/g, '/workspace/code')
      .replace(/\{\{PANE_INDEX\}\}/g, '0');
    parts.push(`<estimator-role>\n${estimatorTemplate}\n</estimator-role>`);
  }

  parts.push(`<estimate-task>
You are the budget estimator for repo "${opts.repoName}" mounted at /workspace/code (read-only).
This is an interactive Slack conversation — the human can ask follow-up questions.

Your task: Estimate the effort needed for: ${opts.description}

Instructions:
1. Read the repo's CLAUDE.md and project structure to understand the codebase
2. Assess the scope of work needed for the task
3. Estimate the number of agents, duration, and cost
4. Output a recommended fleet manifest YAML
5. Include your confidence level and any risk factors

Output your estimate as a clear, formatted response. This will be posted directly to Slack.
Do NOT make any code changes or commits. This is read-only analysis.
Do NOT launch a fleet, create tasks, or take any action. Only produce the estimate.

At the end of your estimate, include a ready-to-use command the user can copy-paste to kick off the work, e.g.:
\`code ${opts.repoName} <one-line description of the recommended approach>\`
or for multi-agent work:
\`fleet ${opts.repoName} <one-line description>\`
</estimate-task>`);

  return parts.join('\n\n');
}

/**
 * Process an estimate task as an interactive conversation.
 *
 * Unlike coding tasks (one-shot), estimates run as regular conversations
 * with a read-only repo mount. The agent stays alive for follow-up questions,
 * clarifications, and decision-making. The conversation persists until the
 * idle timeout, and follow-up messages pipe through normally.
 *
 * Worktree is cleaned up when the container exits.
 */
async function processEstimateTask(
  chatJid: string,
  channel: Channel,
  group: RegisteredGroup,
  repoName: string,
  description: string,
  triggerMessageId?: string,
): Promise<void> {
  const reply = async (text: string) => {
    if (triggerMessageId && channel.sendThreadReply) {
      await channel.sendThreadReply(chatJid, text, triggerMessageId);
    } else {
      await channel.sendMessage(chatJid, text);
    }
  };

  const repo = resolveRepo(repoName);
  if (!repo) {
    await reply(
      `Repo "${repoName}" not found or not allowed. Check ~/.config/nanoclaw/repo-registry.json`,
    );
    return;
  }

  let worktreeInfo;
  try {
    worktreeInfo = await createWorktree(
      repo,
      NANOCLAW_OWNER,
      `estimate-${description}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(`Failed to create worktree: ${msg}`);
    return;
  }

  await reply(
    `Estimating *${repoName}*: ${description}\n_This is an interactive session — ask follow-up questions in this thread._`,
  );

  const teamContext = loadTeamContext(worktreeInfo.repoPath);
  const estimatePrompt = buildEstimatePrompt({
    repoName: worktreeInfo.repoName,
    description,
    teamContext,
    chatJid,
    threadRef: triggerMessageId,
  });

  const restoreGitPaths = patchWorktreeForContainer(worktreeInfo);

  // Track idle timer for worktree cleanup
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const worktreeInfoRef = worktreeInfo;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Estimate idle timeout, closing container',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);

  const output = await runAgent(
    group,
    estimatePrompt,
    chatJid,
    async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) {
          await reply(text);
          resetIdleTimer();
        }
      }
    },
    undefined, // no codingTask — not one-shot
    undefined, // no fleetTask
    {
      worktreePath: worktreeInfo.worktreePath,
      repoGitDir: worktreeInfo.repoGitDir,
      readonly: true,
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Restore git paths and clean up worktree
  restoreGitPaths();
  await cleanupWorktree(worktreeInfoRef);

  if (output === 'error') {
    await reply('Estimate session ended with an error.');
    return;
  }

  await reply(
    `_Estimate session ended. To launch a fleet:_ \`@${getGroupBotName(chatJid)} fleet ${repoName} ${description}\``,
  );
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid, group.channel_id);
          if (!channel) {
            console.log(
              `Warning: no channel owns JID ${chatJid}, skipping messages`,
            );
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
          const loopTriggerPattern = getGroupTriggerPattern(chatJid);

          // ProspectBot handler — direct API, no containers
          if (group.folder === 'prospectbot') {
            const latestMessage = groupMessages[groupMessages.length - 1];
            const messageText = latestMessage.content
              .replace(loopTriggerPattern, '')
              .trim();
            const triggerMessageId =
              latestMessage.thread_ts || latestMessage.id;
            try {
              const response = await handleProspectBotMessage(
                messageText,
                chatJid,
                triggerMessageId,
              );
              if (triggerMessageId && channel.sendThreadReply) {
                await channel.sendThreadReply(
                  chatJid,
                  response,
                  triggerMessageId,
                );
              } else {
                await channel.sendMessage(chatJid, response);
              }
            } catch (err) {
              logger.error({ err, chatJid }, 'ProspectBot handler error');
              const errorText = 'SDR Bot API is unavailable, try again later.';
              if (triggerMessageId && channel.sendThreadReply) {
                await channel.sendThreadReply(
                  chatJid,
                  errorText,
                  triggerMessageId,
                );
              } else {
                await channel.sendMessage(chatJid, errorText);
              }
            }
            lastAgentTimestamp[chatJid] = latestMessage.timestamp;
            saveState();
            continue;
          }

          // Check for pending confirmation approval (before trigger check)
          const loopPending = pendingConfirmations[chatJid];
          if (loopPending) {
            delete pendingConfirmations[chatJid];
            const elapsed = Date.now() - loopPending.timestamp;
            if (elapsed < CONFIRMATION_TIMEOUT_MS) {
              const latestContent = groupMessages[
                groupMessages.length - 1
              ].content
                .toLowerCase()
                .trim();
              const isApproval =
                /^(yes|yeah|yep|y|go|go ahead|do it|sure|ok|launch|start|fix it|ship it)\b/i.test(
                  latestContent,
                );
              if (isApproval) {
                const c = loopPending.classification;
                lastAgentTimestamp[chatJid] =
                  groupMessages[groupMessages.length - 1].timestamp;
                saveState();
                if (c.intent === 'estimate') {
                  processEstimateTask(
                    chatJid,
                    channel,
                    group,
                    c.repo!,
                    c.description,
                    loopPending.triggerMessageId,
                  );
                } else if (c.intent === 'fleet') {
                  const fc = parseFleetTask(`fleet ${c.repo} ${c.description}`);
                  if (fc)
                    processFleetTask(
                      chatJid,
                      channel,
                      group,
                      fc,
                      loopPending.triggerMessageId,
                    );
                } else {
                  processCodingTask(
                    chatJid,
                    channel,
                    group,
                    c.repo!,
                    c.description,
                    loopPending.triggerMessageId,
                  );
                }
                continue;
              }
            } else {
              logger.info(
                {
                  elapsed: Math.round(elapsed / 1000),
                  intent: loopPending.classification.intent,
                },
                'Pending confirmation expired',
              );
            }
          }

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                loopTriggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Check if the latest trigger message is a coding task or fleet task
          const codingTrigger = groupMessages.find((m) =>
            loopTriggerPattern.test(m.content.trim()),
          );
          if (codingTrigger) {
            // --- Admin commands (no container, instant reply) ---
            const adminResult = await handleAdminCommand(
              codingTrigger.content,
              loopTriggerPattern,
              chatJid,
              channel,
            );
            if (adminResult) {
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              continue;
            }

            const codingTask = parseCodingTask(
              codingTrigger.content,
              loopTriggerPattern,
            );
            if (codingTask) {
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              // Run async — don't block the message loop
              processCodingTask(
                chatJid,
                channel,
                group,
                codingTask.repoName,
                codingTask.description,
                codingTrigger.id,
              );
              continue;
            }

            const fleetTask = parseFleetTask(codingTrigger.content);
            if (fleetTask) {
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              processFleetTask(
                chatJid,
                channel,
                group,
                fleetTask,
                codingTrigger.id,
              );
              continue;
            }

            const estimateTask = parseEstimateTask(
              codingTrigger.content,
              loopTriggerPattern,
            );
            if (estimateTask) {
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              processEstimateTask(
                chatJid,
                channel,
                group,
                estimateTask.repoName,
                estimateTask.description,
                codingTrigger.id,
              );
              continue;
            }

            // NL classifier — Haiku call is fast (~200ms)
            const stripped = codingTrigger.content
              .replace(loopTriggerPattern, '')
              .replace(/<@[A-Z0-9]+>/g, '')
              .trim();
            try {
              const classification = await classifyIntent(stripped);
              if (classification) {
                const decision = routingDecision(classification);
                if (decision === 'direct' && classification.repo) {
                  lastAgentTimestamp[chatJid] =
                    groupMessages[groupMessages.length - 1].timestamp;
                  saveState();
                  if (classification.intent === 'estimate') {
                    processEstimateTask(
                      chatJid,
                      channel,
                      group,
                      classification.repo,
                      classification.description,
                      codingTrigger.id,
                    );
                  } else if (classification.intent === 'fleet') {
                    const fc = parseFleetTask(
                      `fleet ${classification.repo} ${classification.description}`,
                    );
                    if (fc) {
                      processFleetTask(
                        chatJid,
                        channel,
                        group,
                        fc,
                        codingTrigger.id,
                      );
                    }
                  } else {
                    processCodingTask(
                      chatJid,
                      channel,
                      group,
                      classification.repo,
                      classification.description,
                      codingTrigger.id,
                    );
                  }
                  continue;
                }
                if (decision === 'confirm') {
                  pendingConfirmations[chatJid] = {
                    classification,
                    timestamp: Date.now(),
                    triggerMessageId: codingTrigger.id,
                  };
                  lastAgentTimestamp[chatJid] =
                    groupMessages[groupMessages.length - 1].timestamp;
                  saveState();
                  const msg = confirmationMessage(classification);
                  if (codingTrigger.id && channel.sendThreadReply) {
                    await channel.sendThreadReply(
                      chatJid,
                      msg,
                      codingTrigger.id,
                    );
                  } else {
                    await channel.sendMessage(chatJid, msg);
                  }
                  continue;
                }
              }
            } catch (err) {
              logger.error(
                { error: err },
                'NL classifier error in message loop',
              );
            }
            // 'chat' or classifier failed — fall through to queue
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            getGroupBotName(chatJid),
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel.setTyping?.(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(
      chatJid,
      sinceTimestamp,
      getGroupBotName(chatJid),
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // Skip Docker check in Azure — ACI dispatch uses REST API, not Docker
  if (process.env.CONTAINER_APP_NAME) {
    logger.info('Running in Container App — skipping Docker runtime check');
  } else {
    ensureContainerSystemRunning();
  }
  initDatabase();
  logger.info('Database initialized');
  loadState();
  checkOrphanedWorktrees();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start health server for Container App liveness + readiness probes
  const healthServer = startHealthServer();

  // Start fleet dispatcher if queue mode is enabled
  let dispatcher: { stop: () => void } | null = null;
  if (process.env.FLEET_USE_QUEUE === '1') {
    // Register Slack reply handler so the dispatcher can send progress to Slack threads.
    // Looks up the correct Slack channel instance via the group's channel_id.
    registerReplyHandler('slack', async (replyTo, text) => {
      if (replyTo.type !== 'slack') return;
      const grp = registeredGroups[replyTo.channelId];
      const targetName = grp?.channel_id || 'slack';
      const slackChannel = channels.find((ch) => ch.name === targetName);
      if (slackChannel && replyTo.threadTs && slackChannel.sendThreadReply) {
        await slackChannel.sendThreadReply(
          replyTo.channelId,
          text,
          replyTo.threadTs,
        );
      } else if (slackChannel) {
        await slackChannel.sendMessage(replyTo.channelId, text);
      }
    });
    dispatcher = startDispatcher();
    logger.info('Fleet dispatcher started (queue mode)');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new work
    setNotReady();

    // Stop dispatcher (waits for current poll to finish, not in-flight fleets)
    if (dispatcher) {
      dispatcher.stop();
      logger.info('Fleet dispatcher stopped');
    }

    // Close servers and channels
    proxyServer.close();
    healthServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();

    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid, group?.channel_id);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    // In queue-only mode (Azure Container App with no local Slack),
    // the dispatcher can run without channels — it replies via the
    // registered reply handlers, not through direct channel connections.
    if (process.env.FLEET_USE_QUEUE === '1') {
      logger.warn('No channels connected — running in dispatcher-only mode');
    } else {
      logger.fatal('No channels connected');
      process.exit(1);
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const grp = registeredGroups[jid];
      const channel = findChannel(channels, jid, grp?.channel_id);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const grp = registeredGroups[jid];
      const channel = findChannel(channels, jid, grp?.channel_id);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    launchFleet: async (chatJid, request) => {
      const group = registeredGroups[chatJid];
      if (!group) {
        logger.warn({ chatJid }, 'launch_fleet: group not registered');
        return;
      }
      const channel = findChannel(channels, chatJid, group.channel_id);
      if (!channel) {
        logger.warn({ chatJid }, 'launch_fleet: no channel for JID');
        return;
      }
      // Launch fleet task — runs async, doesn't block IPC processing
      processFleetTask(
        chatJid,
        channel,
        group,
        {
          repoName: request.repoName,
          description: request.description,
          agents: request.agents,
          timeoutMinutes: request.timeoutMinutes,
        },
        undefined, // no trigger message ID — fleet posts as new message
        request.estimateThreadRef,
      );
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
