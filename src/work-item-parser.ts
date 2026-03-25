/**
 * Work Item URL Parser
 *
 * Parses GitHub and ADO work item references from URLs or shorthand formats.
 * Used by the fleet command to extract repo + issue from a pasted URL.
 *
 * Supported formats:
 *   GitHub issue:   https://github.com/HopSkipInc/ai-fleet/issues/55
 *   GitHub PR:      https://github.com/HopSkipInc/ai-fleet/pull/56
 *   ADO work item:  https://dev.azure.com/saratogasandboxes/Doorbell/_workitems/edit/7300
 *   ADO (old):      https://saratogasandboxes.visualstudio.com/Doorbell/_workitems/edit/7300
 *   Shorthand:      HopSkipInc/ai-fleet #55
 *   ADO shorthand:  ado:Doorbell/SomeService US-7300
 */

// --- Types ---

export type WorkItemSource = 'github' | 'ado';
export type WorkItemType = 'issue' | 'pull_request' | 'work_item';

export interface ParsedWorkItem {
  source: WorkItemSource;
  /** GitHub: "org/repo". ADO: "project/repo" or just "project" */
  repoSlug: string;
  /** Issue number (GitHub) or work item ID (ADO) */
  number: number;
  type: WorkItemType;
  /** ADO org (e.g. "saratogasandboxes"). Undefined for GitHub. */
  adoOrg?: string;
}

// --- URL patterns ---

// https://github.com/HopSkipInc/ai-fleet/issues/55
// https://github.com/HopSkipInc/ai-fleet/pull/56
const GITHUB_URL_RE = /github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/i;

// https://dev.azure.com/saratogasandboxes/Doorbell/_workitems/edit/7300
const ADO_NEW_URL_RE =
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)/i;

// https://saratogasandboxes.visualstudio.com/Doorbell/_workitems/edit/7300
const ADO_OLD_URL_RE =
  /([^/]+)\.visualstudio\.com\/([^/]+)\/_workitems\/edit\/(\d+)/i;

// --- Shorthand patterns ---

// "HopSkipInc/ai-fleet #55" or "HopSkipInc/ai-fleet #55 some description"
const GITHUB_SHORTHAND_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+#(\d+)/;

// "ado:Doorbell/SomeService US-7300" or "ado:Doorbell US-7300"
const ADO_SHORTHAND_RE =
  /^ado:([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)\s+(?:US-|BUG-|TASK-|#)?(\d+)/i;

// --- Slack URL unwrapping ---

// Slack wraps URLs in angle brackets: <https://github.com/...|github.com/...>
// or just <https://github.com/...>
const SLACK_URL_RE = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;

/**
 * Extract a work item reference from a message fragment.
 * Tries URL patterns first, then shorthand.
 *
 * Returns null if no work item reference is found.
 */
export function parseWorkItem(input: string): ParsedWorkItem | null {
  // Unwrap Slack URL formatting
  const unwrapped = input.replace(SLACK_URL_RE, '$1');

  // Try GitHub URL
  const ghUrl = unwrapped.match(GITHUB_URL_RE);
  if (ghUrl) {
    return {
      source: 'github',
      repoSlug: ghUrl[1],
      number: parseInt(ghUrl[3], 10),
      type: ghUrl[2] === 'pull' ? 'pull_request' : 'issue',
    };
  }

  // Try ADO new URL (dev.azure.com)
  const adoNew = unwrapped.match(ADO_NEW_URL_RE);
  if (adoNew) {
    return {
      source: 'ado',
      repoSlug: adoNew[2],
      number: parseInt(adoNew[3], 10),
      type: 'work_item',
      adoOrg: adoNew[1],
    };
  }

  // Try ADO old URL (*.visualstudio.com)
  const adoOld = unwrapped.match(ADO_OLD_URL_RE);
  if (adoOld) {
    return {
      source: 'ado',
      repoSlug: adoOld[2],
      number: parseInt(adoOld[3], 10),
      type: 'work_item',
      adoOrg: adoOld[1],
    };
  }

  // Try ADO shorthand (must check before GitHub shorthand since "ado:" is explicit)
  const adoShort = unwrapped.match(ADO_SHORTHAND_RE);
  if (adoShort) {
    return {
      source: 'ado',
      repoSlug: adoShort[1],
      number: parseInt(adoShort[2], 10),
      type: 'work_item',
    };
  }

  // Try GitHub shorthand
  const ghShort = unwrapped.match(GITHUB_SHORTHAND_RE);
  if (ghShort) {
    return {
      source: 'github',
      repoSlug: ghShort[1],
      number: parseInt(ghShort[2], 10),
      type: 'issue',
    };
  }

  return null;
}

/**
 * Extract remaining description text after removing the work item reference.
 * Returns empty string if the entire input was the reference.
 */
export function extractDescription(
  input: string,
  parsed: ParsedWorkItem,
): string {
  const unwrapped = input.replace(SLACK_URL_RE, '$1');

  // Remove the full URL (including protocol) or shorthand
  let remaining = unwrapped;

  // Remove full URLs (protocol + domain + path)
  remaining = remaining
    .replace(/https?:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/gi, '')
    .replace(
      /https?:\/\/dev\.azure\.com\/[^/]+\/[^/]+\/_workitems\/edit\/\d+/gi,
      '',
    )
    .replace(
      /https?:\/\/[^/]+\.visualstudio\.com\/[^/]+\/_workitems\/edit\/\d+/gi,
      '',
    );

  // Remove shorthand patterns
  if (parsed.source === 'ado') {
    remaining = remaining.replace(ADO_SHORTHAND_RE, '');
  } else {
    remaining = remaining.replace(GITHUB_SHORTHAND_RE, '');
  }

  return remaining.trim();
}
