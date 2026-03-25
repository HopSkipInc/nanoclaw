/**
 * Fleet Dispatcher
 *
 * Reads FleetWorkMessages from Azure Storage Queue and dispatches them
 * to ACI (or local Docker). This is the execution engine — separated from
 * intake so any trigger source can enqueue work.
 *
 * Lifecycle:
 *   1. Poll queue (long-poll with backoff when empty)
 *   2. Dequeue message (visibility timeout = fleet timeout)
 *   3. Resolve target (azure vs local)
 *   4. Dispatch to ACI or local Docker
 *   5. Start FleetTrack progress relay (polls status → replies to source)
 *   6. On completion: delete queue message, clean up ACI container
 *   7. On failure: let visibility timeout expire (retry), or dead-letter after max attempts
 */
import { logger } from './logger.js';
import {
  dequeueFleetWork,
  deleteQueueMessage,
  deadLetterMessage,
  FleetWorkMessage,
} from './fleet-queue.js';
import {
  dispatchFleetToACI,
  cleanupAciFleet,
  getAciFleetState,
} from './fleet-dispatch-aci.js';
import { resolveFleetTarget } from './fleet-task.js';
import { startFleetProgressRelay } from './fleet-progress.js';
import { readFleetStatus, readFleetPrUrl } from './fleet-task.js';

// --- Config ---

const POLL_INTERVAL_EMPTY_MS = 10_000; // 10s when queue is empty
const POLL_INTERVAL_BUSY_MS = 1_000; // 1s when processing
const MAX_CONCURRENT_FLEETS = parseInt(
  process.env.MAX_CONCURRENT_FLEETS || '3',
  10,
);
const MAX_DEQUEUE_FAILURES = 3; // dead-letter after this many failed dispatches

// --- State ---

let running = false;
let activeFleets = 0;

// Reply function registry — maps source type to a reply implementation.
// Populated by the host at startup (e.g., registerReplyHandler('slack', slackReply)).
const replyHandlers = new Map<string, ReplyHandler>();

export type ReplyHandler = (
  replyTo: FleetWorkMessage['source']['replyTo'],
  text: string,
) => Promise<void>;

export function registerReplyHandler(
  sourceType: string,
  handler: ReplyHandler,
): void {
  replyHandlers.set(sourceType, handler);
}

/**
 * Send a reply to the trigger source.
 * Falls back to logging if no handler is registered.
 */
async function reply(
  source: FleetWorkMessage['source'],
  text: string,
): Promise<void> {
  const handler = replyHandlers.get(source.replyTo.type);
  if (handler) {
    await handler(source.replyTo, text);
  } else {
    logger.info(
      { sourceType: source.type, text },
      'No reply handler — logging instead',
    );
  }
}

/**
 * Start the dispatcher loop. Runs until stop() is called.
 */
export function startDispatcher(): { stop: () => void } {
  running = true;
  logger.info(
    { maxConcurrent: MAX_CONCURRENT_FLEETS },
    'Fleet dispatcher starting',
  );

  const loop = async () => {
    while (running) {
      try {
        // Don't exceed concurrency limit
        if (activeFleets >= MAX_CONCURRENT_FLEETS) {
          await sleep(POLL_INTERVAL_BUSY_MS);
          continue;
        }

        // Dequeue (visibility timeout = 2 hours default)
        const item = await dequeueFleetWork(7200);

        if (!item) {
          // Empty queue — back off
          await sleep(POLL_INTERVAL_EMPTY_MS);
          continue;
        }

        // Process in background (don't block the poll loop)
        activeFleets++;
        processMessage(item.message, item.messageId, item.popReceipt).finally(
          () => {
            activeFleets--;
          },
        );

        await sleep(POLL_INTERVAL_BUSY_MS);
      } catch (err) {
        logger.error({ err }, 'Dispatcher loop error');
        await sleep(POLL_INTERVAL_EMPTY_MS);
      }
    }
    logger.info('Fleet dispatcher stopped');
  };

  loop();

  return {
    stop: () => {
      running = false;
      logger.info('Fleet dispatcher stop requested');
    },
  };
}

/**
 * Process a single dequeued message.
 */
async function processMessage(
  message: FleetWorkMessage,
  queueMessageId: string,
  popReceipt: string,
): Promise<void> {
  const { task, fleet, source } = message;
  logger.info(
    { messageId: message.id, repo: task.repoSlug, source: source.type },
    'Processing fleet work message',
  );

  await reply(
    source,
    `Fleet queued for *${task.repoSlug}*: ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`,
  );

  try {
    // Resolve dispatch target
    const target = resolveFleetTarget({
      repoName: task.repoSlug,
      description: task.description,
      target: fleet.target,
    });

    if (target === 'azure') {
      await processAciFleet(message);
    } else {
      // Local Docker path — for now, log and skip
      // TODO: wire up local Docker dispatch when host runs locally
      logger.warn(
        { messageId: message.id },
        'Local dispatch not yet supported in queue mode',
      );
      await reply(
        source,
        'Local fleet dispatch is not yet supported in queue mode. Set target to azure or run from a local NanoClaw instance.',
      );
    }

    // Success — delete the message
    await deleteQueueMessage(queueMessageId, popReceipt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ messageId: message.id, err }, 'Fleet dispatch failed');
    await reply(source, `Fleet dispatch failed: ${msg}`);

    // Let the message become visible again for retry (visibility timeout handles this).
    // After MAX_DEQUEUE_FAILURES, Azure Storage Queue moves it to DLQ automatically
    // if configured — otherwise we handle it manually via dequeueCount.
    // For now, dead-letter explicitly on known fatal errors.
    if (isFatalError(msg)) {
      await deadLetterMessage(message, msg);
      await deleteQueueMessage(queueMessageId, popReceipt);
    }
    // Non-fatal: message becomes visible again after visibility timeout expires
  }
}

/**
 * Dispatch a fleet to ACI and monitor until completion.
 */
async function processAciFleet(message: FleetWorkMessage): Promise<void> {
  const { task, fleet, source } = message;

  const aciResult = await dispatchFleetToACI({
    repoSlug: task.repoSlug,
    description: task.description,
    agents: fleet.agents,
    timeoutMinutes: fleet.timeoutMinutes,
    teamContext: message.teamContext,
    branch: task.branch,
    issueNumber: task.issueNumber,
    modelStrategy: fleet.modelStrategy,
  });

  await reply(
    source,
    `Fleet dispatched to Azure: \`${aciResult.fleetId}\`\nContainer starting — pulling image and initializing (this takes 2-3 min)...`,
  );

  // Poll ACI container state while waiting for fleet-status.json to appear.
  // This bridges the gap between "dispatched" and first agent progress.
  await pollAciStartup(
    aciResult.containerGroupName,
    (text) => reply(source, text),
    180_000, // 3 min max
  );

  // Start FleetTrack — poll Azure Files for status, relay to source
  const azureStatusDir = `/mnt/fleet-status/${aciResult.fleetId}`;
  const progressRelay = startFleetProgressRelay(azureStatusDir, (text) =>
    reply(source, text),
  );

  try {
    // Wait for fleet to complete (progress relay resolves on terminal status)
    await progressRelay.done;
  } finally {
    progressRelay.stop();
  }

  // Read final status
  const finalStatus = readFleetStatus(azureStatusDir);
  const prUrl = readFleetPrUrl(azureStatusDir);

  if (
    finalStatus &&
    (finalStatus.status === 'success' || finalStatus.status === 'completed')
  ) {
    const parts: string[] = [];
    if (finalStatus.message) parts.push(finalStatus.message);
    if (prUrl) parts.push(`PR: ${prUrl}`);
    await reply(source, parts.join('\n\n'));
  } else {
    const statusMsg = finalStatus
      ? `${finalStatus.status}: ${finalStatus.message}`
      : 'Fleet did not report a final status.';
    await reply(source, `Fleet failed. ${statusMsg}`);
  }

  // Clean up ACI container group
  try {
    await cleanupAciFleet(aciResult.containerGroupName);
  } catch (err) {
    logger.warn(
      { err, containerGroupName: aciResult.containerGroupName },
      'ACI cleanup failed',
    );
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll ACI container state during cold start, relaying milestones to Slack.
 * Stops once the container is Running or terminates, or after maxWaitMs.
 */
async function pollAciStartup(
  containerGroupName: string,
  send: (text: string) => Promise<void>,
  maxWaitMs: number,
): Promise<void> {
  const start = Date.now();
  let lastState = '';

  while (Date.now() - start < maxWaitMs) {
    await sleep(15_000);

    const state = await getAciFleetState(containerGroupName);
    if (!state) continue;

    const key = `${state.state}:${state.detail}`;
    if (key === lastState) continue;
    lastState = key;

    if (state.state === 'Running') {
      await send(
        'Container started — fleet agents launching, first progress update in ~1 min.',
      );
      return;
    }

    if (state.state === 'Terminated') {
      if (state.exitCode !== 0) {
        await send(
          `Container exited with code ${state.exitCode}${state.detail ? `: ${state.detail}` : ''}`,
        );
      }
      return;
    }

    if (state.state === 'Waiting' && state.detail) {
      // Only relay non-trivial details (skip "Waiting to run")
      if (
        state.detail.includes('pulling') ||
        state.detail.includes('Pulled')
      ) {
        await send(`Container: ${state.detail}`);
      }
    }
  }
}

/**
 * Detect errors that won't be fixed by retrying.
 */
function isFatalError(message: string): boolean {
  return (
    message.includes('not found or not allowed') ||
    message.includes('No GITHUB_TOKEN') ||
    message.includes('No ADO_PAT') ||
    message.includes('not yet supported') ||
    message.includes('LinkedAuthorizationFailed') ||
    message.includes('AuthorizationFailed') ||
    message.includes('does not have permission')
  );
}
