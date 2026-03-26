/**
 * SDR Batch Approval Handler
 *
 * Routes batch approval commands to the SDR Bot API.
 * Handles: status, approve, skip (by name or number), pause for daily prospect batches.
 *
 * Batch ID resolution uses Option A: GET /batch/pending returns the current
 * pending batch (one active batch per AE at a time).
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
    return { ok: true, status: response.status, text: parsed.text, raw: parsed };
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
 * Resolve the current pending batch ID by calling GET /batch/pending.
 * Returns the batch ID string, or null with an error message.
 */
async function resolvePendingBatchId(): Promise<
  { batchId: string; error: null } | { batchId: null; error: string }
> {
  const result = await callBatchApi('GET', '/batch/pending');
  if (!result.ok) return { batchId: null, error: result.text };

  const batchId = extractBatchId(result.raw);
  if (!batchId) {
    // No batch_id in response — either no pending batch or unexpected format
    return { batchId: null, error: result.text };
  }

  return { batchId, error: null };
}

/**
 * Resolve batch ID then call an action endpoint. Returns the API response text.
 */
async function withPendingBatch(
  method: 'GET' | 'POST',
  pathFn: (batchId: string) => string,
  body?: unknown,
): Promise<string> {
  const resolved = await resolvePendingBatchId();
  if (!resolved.batchId) return resolved.error!;
  const result = await callBatchApi(method, pathFn(resolved.batchId), body);
  return result.text;
}

export async function handleSdrApproval(
  action: ApprovalAction,
): Promise<string> {
  switch (action.type) {
    case 'batch-status': {
      const result = await callBatchApi('GET', '/batch/pending');
      return result.text;
    }

    case 'batch-approve':
      return withPendingBatch('POST', (id) => `/batch/${id}/approve`);

    case 'batch-pause':
      return withPendingBatch('POST', (id) => `/batch/${id}/pause`);

    case 'batch-skip': {
      // API accepts {name: "..."} or {number: N} — lookup is server-side
      const skipBody = /^\d+$/.test(action.target)
        ? { number: parseInt(action.target, 10) }
        : { name: action.target };
      return withPendingBatch('POST', (id) => `/batch/${id}/skip`, skipBody);
    }
  }
}
