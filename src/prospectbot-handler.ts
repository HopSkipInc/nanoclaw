/**
 * ProspectBot Intent Handler
 *
 * Routes messages from #sdr-bot-pilot to the SDR Bot API and relays
 * responses back to Slack. Uses Haiku for natural language intent
 * classification, then calls the appropriate API endpoint.
 */
import { logger } from './logger.js';
import https from 'https';
import {
  handleSdrApproval,
  type ApprovalAction,
} from './sdr-approval-handler.js';

const SDR_API_BASE =
  'https://hs-sdr-app-dev.yellowpond-a7d782a6.eastus2.azurecontainerapps.io';

// Feature flags — flip to true when each endpoint goes live (#51, #52)
const CRM_ENDPOINTS_LIVE: Record<CrmIntelType, boolean> = {
  'crm-check': true,
  'top-planners': true,
  'icp-gaps': true,
};

const CRM_PLACEHOLDER_MESSAGES: Record<CrmIntelType, string> = {
  'crm-check':
    "CRM cross-check is coming soon \u2014 I'll be able to check prospects against HubSpot and show their scores, engagement, and pipeline stage once the endpoint is live.",
  'top-planners':
    "HubSpot pipeline intelligence is coming soon \u2014 I'll be able to rank the most promising planners by their lead score grade, grouped by ICP segment.",
  'icp-gaps':
    "ICP gap analysis is coming soon \u2014 I'll be able to compare your top HubSpot performers against ICP definitions and suggest refinements.",
};

type CrmIntelType = 'crm-check' | 'top-planners' | 'icp-gaps';

type CrmIntelAction =
  | { type: 'crm-check'; slug: IcpSlug }
  | { type: 'top-planners' }
  | { type: 'icp-gaps'; slug: IcpSlug | null };

const KNOWN_SLUGS = ['fiona', 'carrie', 'nancy'] as const;
type IcpSlug = (typeof KNOWN_SLUGS)[number];

const SAMPLE_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingSample {
  slug: IcpSlug;
  count: number;
  timestamp: number;
}

// In-memory pending sample confirmations, keyed by threadKey or chatJid
const pendingSamples: Record<string, PendingSample> = {};

interface ThreadContext {
  slug?: IcpSlug;
  batchId?: string;
  lastIntent?: string;
  lastActivity: number;
}

const THREAD_CONTEXT_TTL_MS = 60 * 60 * 1000; // 60 minutes

// Per-thread conversation context, keyed by threadKey (thread_ts or message ts)
const threadContexts: Record<string, ThreadContext> = {};

function getThreadContext(threadKey: string): ThreadContext | undefined {
  const ctx = threadContexts[threadKey];
  if (!ctx) return undefined;
  if (Date.now() - ctx.lastActivity > THREAD_CONTEXT_TTL_MS) {
    delete threadContexts[threadKey];
    return undefined;
  }
  return ctx;
}

function updateThreadContext(
  threadKey: string,
  updates: Partial<ThreadContext>,
): void {
  const existing = getThreadContext(threadKey) || { lastActivity: Date.now() };
  threadContexts[threadKey] = {
    ...existing,
    ...updates,
    lastActivity: Date.now(),
  };
}

function getApiKey(): string {
  const key = process.env.SDR_BOT_API_KEY;
  if (!key) {
    throw new Error('SDR_BOT_API_KEY environment variable is not set');
  }
  return key;
}

function detectSlug(text: string): IcpSlug | null {
  const lower = text.toLowerCase();
  for (const slug of KNOWN_SLUGS) {
    if (lower.includes(slug)) return slug;
  }
  return null;
}

function parseCount(text: string): number {
  const match = text.match(/\b(\d+)\b/);
  return match ? Math.max(1, Math.min(parseInt(match[1], 10), 100)) : 5;
}

async function callApi(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; text: string }> {
  const url = `${SDR_API_BASE}${path}`;
  logger.info({ method, url }, 'ProspectBot API call');

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
    logger.info({ status: response.status, path }, 'ProspectBot API response');

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
        text: `SDR Bot API error (${response.status}): ${detail}`,
      };
    }

    const parsed = JSON.parse(responseText);
    return { ok: true, status: response.status, text: parsed.text };
  } catch (err) {
    logger.error({ err, path }, 'ProspectBot API call failed');
    return {
      ok: false,
      status: 0,
      text: 'SDR Bot API is unavailable, try again later.',
    };
  }
}

type Intent =
  | { type: 'list' }
  | { type: 'show'; slug: IcpSlug }
  | { type: 'estimate'; slug: IcpSlug }
  | { type: 'sample'; slug: IcpSlug; count: number }
  | { type: 'edit'; slug: IcpSlug; instruction: string }
  | { type: 'help' }
  | ApprovalAction
  | CrmIntelAction;

/**
 * Classify user intent via Haiku LLM call.
 * Falls back to keyword matching if the API call fails.
 */
async function classifyProspectBotIntent(
  text: string,
  contextSlug?: IcpSlug,
): Promise<Intent> {
  const slug = detectSlug(text);

  try {
    const classified = await classifyWithHaiku(text);
    if (classified) {
      // Haiku returns the intent type — combine with detected slug, fall back to thread context
      const resolvedSlug = classified.slug || slug || contextSlug;

      switch (classified.intent) {
        case 'list':
          return { type: 'list' };
        case 'show':
          if (resolvedSlug) return { type: 'show', slug: resolvedSlug };
          return { type: 'list' }; // "show me the ICPs" without a slug → list
        case 'estimate':
          if (resolvedSlug) return { type: 'estimate', slug: resolvedSlug };
          break;
        case 'sample':
          if (resolvedSlug)
            return {
              type: 'sample',
              slug: resolvedSlug,
              count: classified.count || parseCount(text),
            };
          break;
        case 'edit':
          if (resolvedSlug)
            return {
              type: 'edit',
              slug: resolvedSlug,
              instruction: classified.instruction || text,
            };
          break;
        case 'help':
          // If we have a context slug, don't return help yet — fall through
          // to keyword fallback which can resolve slug-dependent intents
          if (!contextSlug) return { type: 'help' };
          break;
        case 'batch-status':
          return { type: 'batch-status' };
        case 'batch-approve':
          return { type: 'batch-approve' };
        case 'batch-pause':
          return { type: 'batch-pause' };
        case 'batch-skip':
          if (classified.target)
            return { type: 'batch-skip', target: classified.target };
          break;
        case 'crm-check':
          if (resolvedSlug) return { type: 'crm-check', slug: resolvedSlug };
          break;
        case 'top-planners':
          return { type: 'top-planners' };
        case 'icp-gaps':
          return { type: 'icp-gaps', slug: resolvedSlug ?? null };
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      'ProspectBot Haiku classification failed, using keyword fallback',
    );
  }

  // Keyword fallback
  return classifyByKeywords(text, contextSlug);
}

function classifyByKeywords(text: string, fallbackSlug?: IcpSlug): Intent {
  const lower = text.toLowerCase();
  const slug = detectSlug(text) || fallbackSlug || null;

  // Batch approval intents (check before ICP intents)
  if (
    /\b(approve\s*all|approve|lgtm|send them|looks good|go ahead)\b/.test(lower)
  )
    return { type: 'batch-approve' };
  if (/\b(pause|hold off|not today|skip today)\b/.test(lower))
    return { type: 'batch-pause' };
  if (
    /\bpending\b/.test(lower) ||
    /\bbatch\b/.test(lower) ||
    /what'?s pending/.test(lower)
  )
    return { type: 'batch-status' };
  if (/\b(skip|remove)\b/.test(lower) && !slug) {
    const target = text
      .replace(/\b(skip|remove)\b/i, '')
      .replace(/#/g, '')
      .trim();
    if (target) return { type: 'batch-skip', target };
  }

  // CRM intelligence intents
  if (
    /\b(crm.?check|check.*(crm|hubspot)|already in hubspot|in hubspot|crm lookup|do we know)\b/.test(
      lower,
    ) &&
    slug
  )
    return { type: 'crm-check', slug };
  if (
    /\b(top planners|best planners|hot leads|best prospects|top contacts|most promising planners|who should we target)\b/.test(
      lower,
    )
  )
    return { type: 'top-planners' };
  if (
    /\b(icp gaps?|look.?alike|what are we missing|icp recommend|compare.*hubspot|how does.*compare)\b/.test(
      lower,
    )
  )
    return { type: 'icp-gaps', slug: slug ?? null };

  // ICP intents
  if (/\b(list|show\s+all|icps)\b/.test(lower)) return { type: 'list' };
  if (/\bestimate\b/.test(lower) && slug) return { type: 'estimate', slug };
  if (/\bsample\b/.test(lower) && slug)
    return { type: 'sample', slug, count: parseCount(text) };
  if (/\b(edit|change|update|exclude|include|add|remove)\b/.test(lower) && slug)
    return { type: 'edit', slug, instruction: text };
  if (/\b(show|see|view|query|config|describe|what)\b/.test(lower) && slug)
    return { type: 'show', slug };
  if (slug) return { type: 'show', slug };

  return { type: 'help' };
}

interface HaikuClassification {
  intent:
    | 'list'
    | 'show'
    | 'estimate'
    | 'sample'
    | 'edit'
    | 'help'
    | 'batch-status'
    | 'batch-approve'
    | 'batch-skip'
    | 'batch-pause'
    | 'crm-check'
    | 'top-planners'
    | 'icp-gaps';
  slug?: IcpSlug;
  count?: number;
  instruction?: string;
  target?: string;
}

async function classifyWithHaiku(
  text: string,
): Promise<HaikuClassification | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are a classifier for an SDR bot that manages ICP profiles AND daily prospect batch approvals. The user sent this message:

"${text}"

Available ICPs: fiona, carrie, nancy

Classify the intent as one of:

ICP management:
- "list" — user wants to see all ICPs
- "show" — user wants to see a specific ICP's config
- "estimate" — user wants match count / credit balance for an ICP
- "sample" — user wants to pull sample prospect results
- "edit" — user wants to modify an ICP (any change, addition, removal, exclusion)

Batch approval:
- "batch-status" — user wants to see pending batches or check status ("status", "what's pending", "show batches")
- "batch-approve" — user wants to approve a batch and send the emails ("approve", "approve all", "lgtm", "send them", "looks good", "go ahead")
- "batch-skip" — user wants to skip/remove a specific prospect from the batch ("skip 3", "skip Maria", "remove #5")
- "batch-pause" — user wants to pause or defer today's batch ("pause", "skip today", "hold off", "not today")

CRM intelligence:
- "crm-check" — user wants to cross-check prospects against HubSpot CRM ("check hubspot", "already in hubspot", "crm lookup", "do we know these people")
- "top-planners" — user wants to see the best/most promising planners from HubSpot ("top planners", "best prospects", "hot leads", "who should we target")
- "icp-gaps" — user wants to compare ICP definitions against HubSpot performers ("icp gaps", "what are we missing", "look-alike analysis", "how does fiona compare")

Other:
- "help" — user is confused or asking what commands are available

Respond with ONLY valid JSON, no markdown:
{"intent": "<type>", "slug": "<icp-name-or-null>", "count": <number-or-null>, "instruction": "<edit-instruction-or-null>", "target": "<skip-target-name-or-number-or-null>"}`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              logger.warn(
                { status: res.statusCode },
                'ProspectBot Haiku API error',
              );
              resolve(null);
              return;
            }
            const response = JSON.parse(data);
            const raw = response.content?.[0]?.text || '';
            const cleaned = raw
              .replace(/^```(?:json)?\s*\n?/i, '')
              .replace(/\n?```\s*$/i, '')
              .trim();
            const parsed = JSON.parse(cleaned) as HaikuClassification;
            // Validate slug
            if (parsed.slug && !KNOWN_SLUGS.includes(parsed.slug as IcpSlug)) {
              parsed.slug = undefined;
            }
            logger.info(
              { intent: parsed.intent, slug: parsed.slug },
              'ProspectBot Haiku classified',
            );
            resolve(parsed);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

function buildHelpMessage(): string {
  return [
    '*ProspectBot Commands*',
    '',
    '_ICP Management_',
    '`list` / `show all` / `icps` — List all ICPs with status',
    '`show <icp>` / `config <icp>` — Show ICP configuration',
    '`estimate <icp>` — Match count + credit balance',
    '`sample <icp> [count]` — Pull sample results (costs credits)',
    '`edit <icp> <instruction>` — Edit ICP with natural language',
    '',
    '_Batch Approval_',
    "`status` / `what's pending` — Show pending batches",
    '`approve` / `lgtm` / `send them` — Approve current batch',
    '`skip <name>` — Remove a prospect from the batch',
    "`pause` / `not today` — Defer today's batch",
    '',
    '_CRM Intelligence_ (coming soon)',
    '`check hubspot <icp>` — Cross-check prospects against HubSpot',
    '`top planners` — Ranked list of most promising HubSpot planners',
    '`icp gaps [icp]` — Compare ICP against top HubSpot performers',
    '',
    `Available ICPs: *${KNOWN_SLUGS.join('*, *')}*`,
  ].join('\n');
}

/**
 * Handle a message from the ProspectBot channel.
 *
 * @param messageText - The raw Slack message text (with @mention already stripped by caller or not)
 * @param chatJid - The chat JID, used to track pending sample confirmations
 * @param threadKey - Optional thread_ts for per-thread conversation context
 * @returns The response text to post back to Slack
 */
export async function handleProspectBotMessage(
  messageText: string,
  chatJid: string,
  threadKey?: string,
): Promise<string> {
  // Strip @mentions (Slack format: <@U12345>)
  const text = messageText.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) return buildHelpMessage();

  // Check for pending sample confirmation first
  const pendingKey = threadKey || chatJid;
  const pending = pendingSamples[pendingKey];
  if (pending) {
    delete pendingSamples[pendingKey];
    const elapsed = Date.now() - pending.timestamp;
    if (elapsed < SAMPLE_CONFIRMATION_TIMEOUT_MS) {
      const lower = text.toLowerCase();
      if (/^(yes|yeah|yep|y|go|go ahead|do it|sure|ok)\b/.test(lower)) {
        const result = await callApi('POST', `/icp/${pending.slug}/sample`, {
          count: pending.count,
        });
        return result.text;
      }
      // Not a confirmation — fall through to normal intent parsing
    } else {
      logger.info(
        { slug: pending.slug, elapsed: Math.round(elapsed / 1000) },
        'ProspectBot sample confirmation expired',
      );
    }
  }

  const ctx = threadKey ? getThreadContext(threadKey) : undefined;
  const intent = await classifyProspectBotIntent(text, ctx?.slug);

  // Update thread context with resolved intent
  if (threadKey) {
    const intentSlug =
      'slug' in intent ? (intent as { slug: IcpSlug }).slug : undefined;
    updateThreadContext(threadKey, {
      ...(intentSlug ? { slug: intentSlug } : {}),
      lastIntent: intent.type,
    });
  }

  switch (intent.type) {
    case 'list': {
      const result = await callApi('GET', '/icp');
      return result.text;
    }

    case 'show': {
      const result = await callApi('GET', `/icp/${intent.slug}`);
      return result.text;
    }

    case 'estimate': {
      const result = await callApi('GET', `/icp/${intent.slug}/estimate`);
      return result.text;
    }

    case 'sample': {
      // Credit protection: call estimate first, then ask for confirmation
      const estimate = await callApi('GET', `/icp/${intent.slug}/estimate`);
      if (!estimate.ok) return estimate.text;

      // Store pending confirmation
      pendingSamples[pendingKey] = {
        slug: intent.slug,
        count: intent.count,
        timestamp: Date.now(),
      };

      return `${estimate.text}\n\nReply *yes* or *go* to pull ${intent.count} sample(s).`;
    }

    case 'edit': {
      const result = await callApi('POST', `/icp/${intent.slug}/edit`, {
        instruction: intent.instruction,
      });
      return result.text;
    }

    case 'batch-status':
    case 'batch-approve':
    case 'batch-skip':
    case 'batch-pause':
      return handleSdrApproval(intent);

    case 'crm-check': {
      if (!CRM_ENDPOINTS_LIVE['crm-check'])
        return CRM_PLACEHOLDER_MESSAGES['crm-check'];
      const result = await callApi('POST', `/icp/${intent.slug}/crm-check`);
      return result.text;
    }

    case 'top-planners': {
      if (!CRM_ENDPOINTS_LIVE['top-planners'])
        return CRM_PLACEHOLDER_MESSAGES['top-planners'];
      const result = await callApi('GET', '/hubspot/top-planners');
      return result.text;
    }

    case 'icp-gaps': {
      if (!CRM_ENDPOINTS_LIVE['icp-gaps'])
        return CRM_PLACEHOLDER_MESSAGES['icp-gaps'];
      const slugParam = intent.slug ? `?slug=${intent.slug}` : '';
      const result = await callApi('GET', `/hubspot/icp-gaps${slugParam}`);
      return result.text;
    }

    case 'help':
    default:
      return buildHelpMessage();
  }
}
