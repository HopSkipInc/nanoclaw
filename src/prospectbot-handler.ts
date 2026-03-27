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
  | { type: 'icp-gaps'; slug: IcpSlug | null }
  | { type: 'crm-detail'; target: string };

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
  crmProspects?: Array<{ email: string | null; name?: string }>;
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

/**
 * Like callApi but also returns the raw parsed JSON for structured field extraction.
 */
async function callApiRaw(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{
  ok: boolean;
  status: number;
  text: string;
  raw: Record<string, unknown>;
}> {
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
    logger.error({ err, path }, 'ProspectBot API call failed');
    return {
      ok: false,
      status: 0,
      text: 'SDR Bot API is unavailable, try again later.',
      raw: {},
    };
  }
}

type Intent =
  | { type: 'list' }
  | { type: 'show'; slug: IcpSlug }
  | { type: 'estimate'; slug: IcpSlug }
  | { type: 'sample'; slug: IcpSlug; count: number }
  | { type: 'edit'; slug: IcpSlug; instruction: string }
  | { type: 'customer-profile'; slug: IcpSlug }
  | { type: 'explain'; question: string }
  | { type: 'guide' }
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
        case 'crm-detail':
          if (classified.target)
            return { type: 'crm-detail', target: classified.target };
          break;
        case 'customer-profile':
          if (resolvedSlug)
            return { type: 'customer-profile', slug: resolvedSlug };
          break;
        case 'explain':
          return { type: 'explain', question: text };
        case 'guide':
          return { type: 'guide' };
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

  // CRM detail intent
  if (/\b(detail|details\s+on|profile)\b/.test(lower)) {
    const target = text
      .replace(/\b(detail|details\s+on|profile)\b/i, '')
      .trim();
    if (target) return { type: 'crm-detail', target };
  }

  // Explain intent — "what happens when", "how does X work", "does this affect"
  if (
    /\b(what happens|how does|does.*(affect|touch|change|modify|cost|push)|where do.*(come from|go)|is it safe)\b/.test(
      lower,
    )
  )
    return { type: 'explain', question: text };

  // Guide / onboarding intent
  if (
    /\b(getting started|walk me through|what can you do|guide|tutorial|i'?m new|show me around)\b/.test(
      lower,
    )
  )
    return { type: 'guide' };

  // Customer profile intent
  if (
    /\b(customer\s+profile|who are our customers|customer analysis|success profile|what do.*customers look like|are we targeting the right|what'?s working)\b/.test(
      lower,
    ) &&
    slug
  )
    return { type: 'customer-profile', slug };

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
    | 'icp-gaps'
    | 'crm-detail'
    | 'customer-profile'
    | 'explain'
    | 'guide';
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

  const prompt = `You are a classifier for Rielly, a revenue intelligence bot for sales teams. The user is an account executive chatting naturally in Slack. Interpret their message and classify the intent.

User message: "${text}"

Available ICPs (ideal customer profiles): fiona (3rd party M&E agencies), carrie (corporate event departments), nancy (associations & non-profits)

Classify as one of these intents:

Understanding customers & targeting:
- "customer-profile" — who are our actual customers, what do they look like, how do they compare to the ICP ("who are our best customers", "what does a typical fiona look like", "are we targeting the right people", "show me the customer profile for fiona", "what's working")
- "icp-gaps" — what's missing from our targeting, where are we leaving money on the table ("what are we missing", "how does our targeting compare", "any gaps in fiona", "are we missing any titles", "who are we not going after that we should be")
- "top-planners" — who are the strongest leads in our pipeline ("who are our best leads", "top prospects", "who should I call first", "hot leads", "most promising planners")
- "crm-check" — do we already know these prospects, are they in HubSpot ("do we know these people", "check hubspot", "are they already in our system", "crm lookup")
- "crm-detail" — drill into a specific contact from a previous CRM check ("tell me more about #3", "detail on the second one", "profile 2", "details on jane@acme.com")

ICP management:
- "show" — see current ICP targeting config ("show me fiona", "what does the fiona ICP look like", "current targeting for carrie")
- "list" — see all available ICPs ("what ICPs do we have", "list them", "show all")
- "estimate" — how many matches and credit cost ("how many fiona matches", "what would it cost", "estimate carrie")
- "sample" — pull real prospect results from FullEnrich ("find me some prospects", "show me 5 fionas", "pull some samples", "who's out there")
- "edit" — change the ICP targeting ("add Senior Event Manager to fiona", "exclude catering companies", "widen the headcount to 100", "narrow fiona to only founders")

Batch approval (daily prospect batches):
- "batch-status" — check pending batches ("what's pending", "any batches to review", "show me today's prospects")
- "batch-approve" — approve and send ("approve", "looks good", "send them", "lgtm", "go ahead")
- "batch-skip" — skip a specific prospect ("skip 3", "skip Maria", "remove the second one")
- "batch-pause" — defer the whole batch ("pause", "not today", "hold off", "skip today")

Questions about the system:
- "explain" — user is asking how something works, what happens when they do something, or wants to understand a feature ("what happens when I approve", "how does sampling work", "what does approve do to HubSpot", "where do the prospects come from", "does this cost money", "what data does this touch")

Onboarding:
- "guide" — user wants a full walkthrough of what they can do ("getting started", "what can you do", "walk me through it", "guide", "tutorial", "I'm new")
- "help" — quick command reference ("help", "commands")

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

// ── Knowledge base for answering "how does X work" questions ──────────────
// This is the single source of truth for the explain intent. Update this when
// behavior changes — no code changes needed for new questions.
const KNOWLEDGE_BASE = `
# Rielly — How It Works

## What Rielly is
Rielly is a revenue intelligence bot for sales teams. It helps AEs understand their customer base, refine targeting, find new prospects, and manage daily prospect batches — all through natural Slack conversation.

## Data sources
- **FullEnrich** — third-party prospect discovery service. Searches cost credits (~$0.03/contact). Used for "sample" and discovery.
- **HubSpot** — your CRM. Read-only for most operations (CRM check, top planners, customer profiles). Batch approval does NOT currently push to HubSpot — it only marks prospects as approved in Rielly's internal state.
- **ICP configs** — YAML files defining ideal customer profiles (titles, industries, company size, location). Stored in the SDR pipeline, editable via natural language.

## Actions and what they do

### Sampling (costs money)
- "sample" / "find me prospects" calls FullEnrich, which costs credits
- Before sampling, Rielly always shows an estimate (match count + credit cost) and asks for confirmation
- You must explicitly confirm before any credits are spent

### Batch approval
- The pipeline generates daily prospect batches for review
- **"approve"** marks all pending prospects in a batch as approved in Rielly's internal database
- **TODAY: Approve does NOT push contacts to HubSpot or any other system.** It is a status change only. The CRM push pipeline is not yet connected.
- **"skip [name/number]"** removes one prospect from the batch
- **"pause"** defers the entire batch

### CRM check (read-only)
- Cross-references prospects against HubSpot contacts
- Read-only — does not create, update, or delete any HubSpot data
- Shows lead grade, engagement status, and pipeline stage

### Customer profile (read-only)
- Analyzes your actual HubSpot customer base for an ICP segment
- Compares real customers against ICP targeting definitions
- Read-only — no CRM modifications

### ICP editing
- "edit" changes the targeting config (titles, industries, headcount, etc.)
- Changes are saved to the ICP YAML config file
- Does not trigger any external API calls or data changes

### Estimates (free)
- Shows match count and credit cost without pulling results
- No credits spent, no external calls beyond FullEnrich's count endpoint

## What does NOT happen (common concerns)
- Approving a batch does NOT create contacts in HubSpot (not yet wired)
- CRM check does NOT modify HubSpot data
- Viewing profiles does NOT trigger enrichment
- No data is sent to external systems without explicit confirmation
- No emails are sent — Rielly is purely a data and targeting tool
`;

async function answerFromKnowledgeBase(question: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return buildHelpMessage();

  const prompt = `You are Rielly, a revenue intelligence bot. A user asked a question about how you work. Answer it clearly and concisely using ONLY the knowledge base below. If the knowledge base doesn't cover it, say so honestly.

Use Slack mrkdwn formatting. Keep the answer to 2-4 sentences unless the question needs more detail. Be direct — lead with the answer, not preamble.

<knowledge-base>
${KNOWLEDGE_BASE}
</knowledge-base>

User question: "${question}"`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
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
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve(buildHelpMessage());
              return;
            }
            const response = JSON.parse(data);
            const answer = response.content?.[0]?.text || '';
            resolve(answer.trim() || buildHelpMessage());
          } catch {
            resolve(buildHelpMessage());
          }
        });
      },
    );
    req.on('error', () => resolve(buildHelpMessage()));
    req.on('timeout', () => {
      req.destroy();
      resolve(buildHelpMessage());
    });
    req.write(body);
    req.end();
  });
}

function buildHelpMessage(): string {
  return [
    '*Rielly — Revenue Intelligence*',
    '',
    'Just ask naturally — "who are our best customers", "are we targeting the right people", "find me some prospects." Or use these:',
    '',
    '_Understand & target_',
    '• `customer profile <icp>` — What do actual customers look like vs the ICP?',
    '• `icp gaps <icp>` — Where is the ICP leaving money on the table?',
    '• `top planners` — Best leads in the pipeline right now',
    '• `check hubspot <icp>` — Are these prospects already in HubSpot?',
    '',
    '_Find & refine_',
    '• `show <icp>` — Current targeting config',
    '• `edit <icp> <change>` — Adjust targeting ("add Senior Event Manager to titles")',
    '• `sample <icp> [count]` — Pull real prospects (costs credits)',
    '',
    '_Daily batches_',
    "• `what's pending` — Today's prospects to review",
    '• `approve` / `skip <name>` / `pause`',
    '',
    `ICPs: *${KNOWN_SLUGS.join('*, *')}*  •  Say "guide" for a walkthrough`,
  ].join('\n');
}

function buildGuideMessage(): string {
  return [
    '*Getting Started with Rielly*',
    '',
    "Rielly helps you understand who your best customers are, whether you're targeting the right people, and find new prospects that match. Here's how to use it:",
    '',
    "*Step 1: See what's working*",
    '_"What do our fiona customers look like?"_',
    "This pulls your actual customer data — who they are, what titles they hold, how active they are on the platform, where they're located. It compares this against your ICP definition and tells you what's missing.",
    '',
    '*Step 2: Close the gaps*',
    '_"Are there gaps in fiona?" or "What are we missing?"_',
    "If customers have titles or industries your ICP doesn't target, you'll see them here. When it suggests a fix, you can say it right back:",
    '_"Add Senior Event Manager to fiona\'s target titles"_',
    '',
    '*Step 3: Find new prospects*',
    '_"Find me 5 fiona prospects" or "Sample fiona"_',
    'This searches FullEnrich for real people matching your ICP. Costs credits, so it asks for confirmation first.',
    '',
    '*Step 4: Check before you reach out*',
    '_"Do we already know these people?"_',
    'Cross-checks your sample against HubSpot — shows who\'s already in the system, their grade, and engagement. Say "tell me more about #3" to drill in.',
    '',
    '*Step 5: Review daily batches*',
    '_"What\'s pending?"_',
    'When the pipeline runs, it\'ll post prospect batches here for your approval. Say "approve" to send, "skip Maria" to remove one, or "pause" to defer.',
    '',
    '*Other things you can ask:*',
    '• _"Who are our best leads?"_ — top planners by HubSpot grade',
    '• _"Show me the fiona config"_ — current targeting',
    '• _"How many fiona matches are there?"_ — match count + cost',
    '',
    `ICPs: *${KNOWN_SLUGS.join('*, *')}* (Fiona = agencies, Carrie = corporate, Nancy = associations)`,
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
      return `${result.text}\n\n_Try: \`estimate\` · \`sample 5\` · \`edit <instruction>\` · \`check hubspot\`_`;
    }

    case 'estimate': {
      const result = await callApi('GET', `/icp/${intent.slug}/estimate`);
      return `${result.text}\n\n_Try: \`sample 5\` · \`show\` · \`edit <instruction>\`_`;
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
      return `${result.text}\n\n_Try: \`show\` · \`estimate\` · \`sample 5\`_`;
    }

    case 'batch-status':
    case 'batch-approve':
    case 'batch-skip':
    case 'batch-pause':
      return handleSdrApproval(intent, threadKey);

    case 'crm-check': {
      if (!CRM_ENDPOINTS_LIVE['crm-check'])
        return CRM_PLACEHOLDER_MESSAGES['crm-check'];
      const result = await callApiRaw('POST', `/icp/${intent.slug}/crm-check`);
      // Store prospect emails in thread context for detail lookups
      if (threadKey && result.ok && Array.isArray(result.raw.prospects)) {
        const prospects = (
          result.raw.prospects as Array<{
            email?: string | null;
            name?: string;
          }>
        ).map((p) => ({ email: p.email ?? null, name: p.name }));
        updateThreadContext(threadKey, { crmProspects: prospects });
      }
      return `${result.text}\n\n_Try: \`detail <number>\` · \`top planners\` · \`icp gaps\`_`;
    }

    case 'top-planners': {
      if (!CRM_ENDPOINTS_LIVE['top-planners'])
        return CRM_PLACEHOLDER_MESSAGES['top-planners'];
      const result = await callApi('GET', '/hubspot/top-planners');
      return `${result.text}\n\n_Try: \`icp gaps\` · \`check hubspot <icp>\`_`;
    }

    case 'icp-gaps': {
      if (!CRM_ENDPOINTS_LIVE['icp-gaps'])
        return CRM_PLACEHOLDER_MESSAGES['icp-gaps'];
      const slugParam = intent.slug ? `?slug=${intent.slug}` : '';
      const result = await callApi('GET', `/hubspot/icp-gaps${slugParam}`);
      return `${result.text}\n\n_Try: \`top planners\` · \`check hubspot <icp>\` · \`edit <instruction>\` · \`customer profile <icp>\`_`;
    }

    case 'customer-profile': {
      const result = await callApi(
        'GET',
        `/hubspot/customer-profile?slug=${intent.slug}`,
      );
      return result.text;
    }

    case 'crm-detail': {
      const ctx2 = threadKey ? getThreadContext(threadKey) : undefined;
      if (
        ctx2?.lastIntent !== 'crm-check' &&
        ctx2?.lastIntent !== 'crm-detail'
      ) {
        return 'Run a CRM check first, then ask for details.';
      }
      const detailSlug = ctx2?.slug;
      if (!detailSlug) return 'Run a CRM check first, then ask for details.';

      let email: string;
      if (intent.target.includes('@')) {
        // Direct email
        email = intent.target;
      } else {
        // Number — resolve from stored prospects
        const num = parseInt(intent.target, 10);
        const prospects = ctx2?.crmProspects;
        if (!prospects || prospects.length === 0) {
          return 'No prospect data available — run a CRM check first, or provide an email address directly.';
        }
        if (isNaN(num) || num < 1 || num > prospects.length) {
          return `That CRM check only had ${prospects.length} contact${prospects.length === 1 ? '' : 's'}. Try \`detail 1\` through \`detail ${prospects.length}\`, or use an email address.`;
        }
        const prospect = prospects[num - 1];
        if (!prospect.email) {
          const name = prospect.name || `#${num}`;
          return `No email on file for ${name} (pre-enrichment). Try providing their email directly: \`detail jane@acme.com\``;
        }
        email = prospect.email;
      }

      const result = await callApi(
        'GET',
        `/icp/${detailSlug}/crm-check/${encodeURIComponent(email)}`,
      );
      if (!result.ok && result.status === 404) {
        return `No HubSpot profile found for ${email}.`;
      }
      return result.text;
    }

    case 'explain':
      return answerFromKnowledgeBase(intent.question);

    case 'guide':
      return buildGuideMessage();

    case 'help':
    default:
      return buildHelpMessage();
  }
}
