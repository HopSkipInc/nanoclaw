/**
 * SDR Batch Approval Handler
 *
 * Routes batch approval commands to the SDR Bot API.
 * Handles: status, approve, skip (by name or number), pause for daily prospect batches.
 *
 * Batch ID resolution: prefers GET /batch/by-thread?slack_ts={ts} for exact
 * thread-to-batch matching. Falls back to GET /batch/pending when no thread
 * context is available.
 */
import { logger } from './logger.js';

const SDR_API_BASE =
  'https://hs-sdr-app-dev.yellowpond-a7d782a6.eastus2.azurecontainerapps.io';

export type ApprovalAction =
  | { type: 'batch-status' }
  | { type: 'batch-approve' }
  | { type: 'batch-skip'; target: string }
  | { type: 'batch-pause' };

function getApiKey(): string {
  const key = process.env.SDR_BOT_API_KEY;
  if (!key) throw new Error('SDR_BOT_API_KEY environment variable is not set');
  return key;
}

interface ApiResult {
  ok: boolean;
  status: number;
  text: string;
  raw: Record<string, unknown>;
}

async function callBatchApi(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const url = `${SDR_API_BASE}${path}`;
  logger.info({ method, url }, 'SDR batch API call');

  const headers: Record<string, string> = {
    'X-Api-Key': getApiKey(),
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const responseText = await response.text();
    logger.info({ status: response.status, path }, 'SDR batch API response');

    if (!response.ok) {
      let detail = responseText;
      try {
        const parsed = JSON.parse(responseText);
        if (parsed.detail) detail = parsed.detail;
      } catch {
        // use raw text
      }
      return {
        ok: false,
        status: response.status,
        text: `API error (${response.status}): ${detail}`,
        raw: {},
      };
    }

    const parsed = JSON.parse(responseText);
    return {
      ok: true,
      status: response.status,
      text: parsed.text,
      raw: parsed,
    };
  } catch (err) {
    logger.error({ err, path }, 'SDR batch API call failed');
    return {
      ok: false,
      status: 0,
      text: 'SDR Bot API is unavailable, try again later.',
      raw: {},
    };
  }
}

/**
 * Extract batch_id from API response. All batch endpoints return
 * {"text": "...", "batch_id": "abc123"} as a structured field.
 */
function extractBatchId(raw: Record<string, unknown>): string | null {
  if (raw.batch_id && typeof raw.batch_id === 'string') return raw.batch_id;
  return null;
}

/**
 * Resolve batch ID from the Slack thread via GET /batch/by-thread?slack_ts={ts}.
 * Falls back to GET /batch/pending when no threadKey is available.
 */
async function resolveBatchId(
  threadKey?: string,
): Promise<{ batchId: string; error: null } | { batchId: null; error: string }> {
  // Prefer thread-based lookup for exact batch resolution
  if (threadKey) {
    const result = await callBatchApi(
      'GET',
      `/batch/by-thread?slack_ts=${encodeURIComponent(threadKey)}`,
    );
    if (result.ok) {
      const batchId = extractBatchId(result.raw);
      if (batchId) return { batchId, error: null };
    }
    // 404 = no batch for this thread — fall through to pending
    if (result.status !== 404) {
      return { batchId: null, error: result.text };
    }
  }

  // Fallback: most recent pending batch
  const result = await callBatchApi('GET', '/batch/pending');
  if (!result.ok) return { batchId: null, error: result.text };

  const batchId = extractBatchId(result.raw);
  if (!batchId) {
    return { batchId: null, error: result.text };
  }

  return { batchId, error: null };
}

/**
 * Resolve batch ID then call an action endpoint. Returns the API response text.
 */
async function withBatch(
  method: 'GET' | 'POST',
  pathFn: (batchId: string) => string,
  threadKey?: string,
  body?: unknown,
): Promise<string> {
  const resolved = await resolveBatchId(threadKey);
  if (!resolved.batchId) return resolved.error!;
  const result = await callBatchApi(method, pathFn(resolved.batchId), body);
  return result.text;
}

export async function handleSdrApproval(
  action: ApprovalAction,
  threadKey?: string,
): Promise<string> {
  switch (action.type) {
    case 'batch-status': {
      // Status shows pending batches — use thread lookup if available,
      // otherwise shows all pending
      if (threadKey) {
        const result = await callBatchApi(
          'GET',
          `/batch/by-thread?slack_ts=${encodeURIComponent(threadKey)}`,
        );
        if (result.ok) return result.text;
      }
      const result = await callBatchApi('GET', '/batch/pending');
      return result.text;
    }

    case 'batch-approve':
      return withBatch('POST', (id) => `/batch/${id}/approve`, threadKey);

    case 'batch-pause':
      return withBatch('POST', (id) => `/batch/${id}/pause`, threadKey);

    case 'batch-skip': {
      // API accepts {name: "..."} or {number: N} — lookup is server-side
      const skipBody = /^\d+$/.test(action.target)
        ? { number: parseInt(action.target, 10) }
        : { name: action.target };
      return withBatch(
        'POST',
        (id) => `/batch/${id}/skip`,
        threadKey,
        skipBody,
      );
    }
  }
}
