/**
 * ProspectBot Intent Handler
 *
 * Routes messages from #sdr-bot-pilot to the SDR Bot API and relays
 * responses back to Slack. No containers, no LLM — keyword matching only.
 */
import { logger } from './logger.js';

const SDR_API_BASE =
  'https://hs-sdr-app-dev.yellowpond-a7d782a6.eastus2.azurecontainerapps.io';

const KNOWN_SLUGS = ['fiona', 'carrie', 'nancy'] as const;
type IcpSlug = (typeof KNOWN_SLUGS)[number];

const SAMPLE_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingSample {
  slug: IcpSlug;
  count: number;
  timestamp: number;
}

// In-memory pending sample confirmations, keyed by chatJid
const pendingSamples: Record<string, PendingSample> = {};

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
    'Accept': 'application/json',
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
    logger.info(
      { status: response.status, path },
      'ProspectBot API response',
    );

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
  | { type: 'help' };

function classifyProspectBotIntent(text: string): Intent {
  const lower = text.toLowerCase();
  const slug = detectSlug(text);

  // "list" / "show all" / "icps"
  if (/\b(list|show\s+all|icps)\b/.test(lower)) {
    return { type: 'list' };
  }

  // "estimate" + slug
  if (/\bestimate\b/.test(lower) && slug) {
    return { type: 'estimate', slug };
  }

  // "sample" + slug
  if (/\bsample\b/.test(lower) && slug) {
    return { type: 'sample', slug, count: parseCount(text) };
  }

  // "edit" / "change" / "update" / "exclude" / "include" / "add" / "remove" + slug
  if (
    /\b(edit|change|update|exclude|include|add|remove)\b/.test(lower) &&
    slug
  ) {
    return { type: 'edit', slug, instruction: text };
  }

  // "show" / "query" / "config" + slug
  if (/\b(show|query|config)\b/.test(lower) && slug) {
    return { type: 'show', slug };
  }

  return { type: 'help' };
}

function buildHelpMessage(): string {
  return [
    '*ProspectBot Commands*',
    '',
    '`list` / `show all` / `icps` — List all ICPs with status',
    '`show <icp>` / `config <icp>` — Show ICP configuration',
    '`estimate <icp>` — Match count + credit balance',
    '`sample <icp> [count]` — Pull sample results (costs credits)',
    '`edit <icp> <instruction>` — Edit ICP with natural language',
    '',
    `Available ICPs: *${KNOWN_SLUGS.join('*, *')}*`,
  ].join('\n');
}

/**
 * Handle a message from the ProspectBot channel.
 *
 * @param messageText - The raw Slack message text (with @mention already stripped by caller or not)
 * @param chatJid - The chat JID, used to track pending sample confirmations
 * @returns The response text to post back to Slack
 */
export async function handleProspectBotMessage(
  messageText: string,
  chatJid: string,
): Promise<string> {
  // Strip @mentions (Slack format: <@U12345>)
  const text = messageText.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) return buildHelpMessage();

  // Check for pending sample confirmation first
  const pending = pendingSamples[chatJid];
  if (pending) {
    delete pendingSamples[chatJid];
    const elapsed = Date.now() - pending.timestamp;
    if (elapsed < SAMPLE_CONFIRMATION_TIMEOUT_MS) {
      const lower = text.toLowerCase();
      if (/^(yes|yeah|yep|y|go|go ahead|do it|sure|ok)\b/.test(lower)) {
        const result = await callApi(
          'POST',
          `/icp/${pending.slug}/sample`,
          { count: pending.count },
        );
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

  const intent = classifyProspectBotIntent(text);

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
      pendingSamples[chatJid] = {
        slug: intent.slug,
        count: intent.count,
        timestamp: Date.now(),
      };

      return `${estimate.text}\n\nReply *yes* or *go* to pull ${intent.count} sample(s).`;
    }

    case 'edit': {
      const result = await callApi(
        'POST',
        `/icp/${intent.slug}/edit`,
        { instruction: intent.instruction },
      );
      return result.text;
    }

    case 'help':
    default:
      return buildHelpMessage();
  }
}
