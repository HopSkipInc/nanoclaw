/**
 * Fleet Progress Relay
 *
 * Polls fleet status files on the host and relays updates to Slack.
 * Runs alongside the container — starts when the fleet container launches,
 * stops when the fleet completes or the container exits.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const STATUS_HEARTBEAT_MS = 300_000; // 5 minutes — periodic status even if nothing changed

export interface FleetStatus {
  status: string;
  started_at: string;
  updated_at: string;
  duration_seconds: number;
  summary: string;
  pr_url: string | null;
  error: string | null;
  agents: {
    total: number;
    active: number;
    stale: number;
    exited: number;
  };
  goal: string | null;
  repo: string | null;
  issue: number | null;
}

export interface ProgressEntry {
  timestamp: string;
  agent: string;
  phase: string;
  message: string;
}

type SendFn = (text: string) => Promise<void>;

/**
 * Start polling fleet status and relaying progress to Slack.
 *
 * Returns a stop function. The relay also stops automatically when it
 * detects a terminal fleet status (success, failed, timeout, blocked).
 */
export function startFleetProgressRelay(
  fleetStatusDir: string,
  send: SendFn,
): { stop: () => void; done: Promise<void> } {
  let stopped = false;
  let progressOffset = 0; // byte offset into progress.jsonl
  let lastStatus = '';
  let lastAgentSummary = '';
  let lastHeartbeatTime = Date.now();
  let resolvePromise: () => void;

  const donePromise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  const stop = () => {
    stopped = true;
  };

  const poll = async () => {
    while (!stopped) {
      try {
        await pollOnce();
      } catch (err) {
        logger.debug({ err, fleetStatusDir }, 'Fleet progress poll error');
      }
      await sleep(POLL_INTERVAL_MS);
    }
    resolvePromise();
  };

  const pollOnce = async () => {
    // --- Read new progress entries ---
    const progressFile = path.join(fleetStatusDir, 'progress.jsonl');
    if (fs.existsSync(progressFile)) {
      const stat = fs.statSync(progressFile);
      if (stat.size > progressOffset) {
        const fd = fs.openSync(progressFile, 'r');
        const buf = Buffer.alloc(stat.size - progressOffset);
        fs.readSync(fd, buf, 0, buf.length, progressOffset);
        fs.closeSync(fd);
        progressOffset = stat.size;

        const lines = buf
          .toString('utf-8')
          .split('\n')
          .filter((l) => l.trim());
        const entries = parseProgressLines(lines);
        if (entries.length > 0) {
          await relayProgress(entries, send);
        }
      }
    }

    // --- Read fleet status ---
    const statusFile = path.join(fleetStatusDir, 'fleet-status.json');
    if (fs.existsSync(statusFile)) {
      try {
        const data = JSON.parse(
          fs.readFileSync(statusFile, 'utf-8'),
        ) as FleetStatus;

        // Relay agent count changes
        const agentSummary = formatAgentSummary(data.agents);
        if (agentSummary && agentSummary !== lastAgentSummary) {
          lastAgentSummary = agentSummary;
          await send(agentSummary);
          lastHeartbeatTime = Date.now();
        }

        // Periodic heartbeat with elapsed time + cost (even if agent counts unchanged)
        const now = Date.now();
        if (now - lastHeartbeatTime >= STATUS_HEARTBEAT_MS && data.summary) {
          await send(`Fleet status: ${data.summary}`);
          lastHeartbeatTime = now;
        }

        // Detect terminal status
        if (data.status !== lastStatus) {
          lastStatus = data.status;
          if (isTerminalStatus(data.status)) {
            const summary = formatStatusSummary(data);
            if (summary) {
              await send(summary);
            }
            stopped = true;
          }
        }
      } catch {
        // Ignore parse errors — file may be mid-write
      }
    }
  };

  // Start polling in background
  poll();

  return { stop, done: donePromise };
}

function parseProgressLines(lines: string[]): ProgressEntry[] {
  const entries: ProgressEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ProgressEntry;
      if (entry.agent && entry.message) {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Batch progress entries and send as a single message.
 * Groups by agent to reduce Slack noise.
 */
async function relayProgress(
  entries: ProgressEntry[],
  send: SendFn,
): Promise<void> {
  // Group consecutive entries for readability
  const lines: string[] = [];
  for (const entry of entries) {
    const phase = entry.phase ? ` [${entry.phase}]` : '';
    lines.push(`*${entry.agent}*${phase}: ${entry.message}`);
  }

  if (lines.length > 0) {
    // Cap at 10 lines per message to avoid Slack walls
    const batch = lines.slice(0, 10);
    if (lines.length > 10) {
      batch.push(`_...and ${lines.length - 10} more updates_`);
    }
    await send(batch.join('\n'));
  }
}

function formatAgentSummary(agents: FleetStatus['agents']): string | null {
  if (agents.total === 0) return null;
  const parts: string[] = [];
  if (agents.active > 0) parts.push(`${agents.active} active`);
  if (agents.stale > 0) parts.push(`${agents.stale} stale`);
  if (agents.exited > 0) parts.push(`${agents.exited} exited`);
  if (parts.length === 0) return null;
  return `Fleet agents (${agents.total} total): ${parts.join(', ')}`;
}

function formatStatusSummary(data: FleetStatus): string | null {
  const durationMin = Math.round(data.duration_seconds / 60);

  switch (data.status) {
    case 'success':
    case 'completed':
      return `Fleet completed in ${durationMin}m${data.summary ? `: ${data.summary}` : ''}`;
    case 'failed':
      return `Fleet failed after ${durationMin}m${data.error ? `: ${data.error}` : ''}`;
    case 'timeout':
      return `Fleet timed out after ${durationMin}m${data.summary ? `: ${data.summary}` : ''}`;
    case 'blocked':
      return `Fleet blocked after ${durationMin}m${data.summary ? `: ${data.summary}` : ''}`;
    default:
      return null;
  }
}

function isTerminalStatus(status: string): boolean {
  return ['success', 'completed', 'failed', 'timeout', 'blocked'].includes(
    status,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
