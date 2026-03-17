/**
 * Natural Language Intent Classifier for NanoClaw (C7)
 *
 * Uses Haiku to classify incoming messages into intents:
 * - code: user wants code changes in a specific repo
 * - estimate: user wants effort/cost estimation
 * - fleet: user wants a multi-agent fleet task
 * - chat: regular conversation (no coding action)
 *
 * Three confidence tiers:
 * - High (>= 0.95): route directly, no confirmation
 * - Medium (0.3–0.94): ask for confirmation
 * - Low (< 0.3): fall through to chat
 */
import http from 'http';
import https from 'https';

import { readEnvFile } from './env.js';
import { loadRepoRegistry, RepoEntry } from './coding-task.js';
import { logger } from './logger.js';

export interface ClassifiedIntent {
  intent: 'code' | 'estimate' | 'fleet' | 'chat';
  repo: string | null;
  description: string;
  confidence: number;
}

const HIGH_CONFIDENCE = 0.95;
const MEDIUM_CONFIDENCE = 0.3;

/**
 * Classify a message using Claude Haiku.
 * Returns null if the API call fails (caller should fall through to chat).
 */
export async function classifyIntent(
  message: string,
): Promise<ClassifiedIntent | null> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]);
  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('No ANTHROPIC_API_KEY — skipping intent classification');
    return null;
  }

  const registry = loadRepoRegistry();
  const repoList = registry
    ? Object.entries(registry.repos).map(
        ([name, entry]: [string, RepoEntry]) =>
          `- ${name}: ${entry.description || 'no description'}`,
      )
    : [];

  const systemPrompt = `You are an intent classifier for a coding assistant bot. Given a user message and a list of available repositories, determine:

1. **intent**: What does the user want?
   - "code" — They want code changes made (fix a bug, add a feature, refactor, update config, etc.)
   - "estimate" — They want to know effort, cost, or scope of a change before committing
   - "fleet" — They explicitly want a multi-agent fleet (they'll say "fleet" or "swarm" or "team of agents")
   - "chat" — They want to discuss, ask a question, get information, or anything that isn't a coding action

2. **repo**: Which repository is the target? Use the exact name from the list. null if unclear or not applicable.

3. **description**: A concise description of what the user wants done (reworded for clarity if needed).

4. **confidence**: 0.0 to 1.0. How certain are you about the intent AND repo combined?
   - 0.95+ = explicit action verb + unambiguous repo name mentioned
   - 0.7–0.94 = clear intent, repo is referenced but phrased naturally
   - 0.3–0.7 = likely an action request but repo or intent is ambiguous
   - <0.3 = conversational, no clear action requested

Available repositories:
${repoList.join('\n')}

Respond with ONLY valid JSON, no markdown fences:
{"intent": "code|estimate|fleet|chat", "repo": "RepoName|null", "description": "...", "confidence": 0.0}`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  });

  const baseUrl = secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  try {
    const raw = await callAnthropicAPI(baseUrl, apiKey, body);
    // Strip markdown fences — Haiku often wraps JSON in ```json ... ``` despite instructions
    const result = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(result) as ClassifiedIntent;

    // Validate
    if (
      !['code', 'estimate', 'fleet', 'chat'].includes(parsed.intent) ||
      typeof parsed.confidence !== 'number'
    ) {
      logger.warn({ result }, 'Invalid classifier response');
      return null;
    }

    logger.info(
      {
        intent: parsed.intent,
        repo: parsed.repo,
        confidence: parsed.confidence,
        message: message.slice(0, 80),
      },
      'Intent classified',
    );

    return parsed;
  } catch (err) {
    logger.error({ err }, 'Intent classification failed');
    return null;
  }
}

/**
 * Determine the routing action based on classification confidence.
 */
export function routingDecision(
  classification: ClassifiedIntent,
): 'direct' | 'confirm' | 'chat' {
  if (classification.intent === 'chat') return 'chat';
  if (classification.confidence >= HIGH_CONFIDENCE) return 'direct';
  if (classification.confidence >= MEDIUM_CONFIDENCE) return 'confirm';
  return 'chat';
}

/**
 * Format a confirmation message for medium-confidence classifications.
 */
export function confirmationMessage(c: ClassifiedIntent): string {
  const intentLabel =
    c.intent === 'code'
      ? 'create a fix'
      : c.intent === 'estimate'
        ? 'estimate the effort'
        : 'launch a fleet';
  const repoLabel = c.repo ? ` in *${c.repo}*` : '';
  return `Sounds like you want me to ${intentLabel}${repoLabel}: "${c.description}"\n\nShould I go ahead, or did you just want to discuss?`;
}

// --- HTTP helper (no external deps) ---

function callAnthropicAPI(
  baseUrl: string,
  apiKey: string,
  body: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/messages', baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const response = JSON.parse(data);
          const text =
            response.content?.[0]?.text || '';
          resolve(text);
        } catch (err) {
          reject(new Error(`Failed to parse API response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
