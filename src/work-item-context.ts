/**
 * Work Item Context Fetcher
 *
 * Fetches rich context from GitHub issues/PRs and ADO work items
 * to inject into fleet goals. The fleet agents get the full picture
 * of what they're working on — title, description, acceptance criteria,
 * labels, and recent discussion.
 */
import { logger } from './logger.js';
import { ParsedWorkItem } from './work-item-parser.js';

// --- Types ---

export interface WorkItemContext {
  title: string;
  body: string;
  /** Labels (GitHub) or tags (ADO) */
  labels: string[];
  /** Recent comments/discussion (capped) */
  comments: string[];
  /** Work item type hint for agent composition */
  typeHint: 'bug' | 'feature' | 'task' | 'unknown';
  /** Raw source for attribution */
  sourceUrl: string;
}

// Max context size to avoid blowing up the fleet config env var
const MAX_BODY_CHARS = 3000;
const MAX_COMMENTS = 5;
const MAX_COMMENT_CHARS = 500;

// --- GitHub ---

/**
 * Fetch context from a GitHub issue or PR.
 * Uses the GitHub API with the provided token.
 */
export async function fetchGitHubContext(
  repoSlug: string,
  number: number,
  type: 'issue' | 'pull_request',
  token: string,
): Promise<WorkItemContext> {
  const endpoint = type === 'pull_request' ? 'pulls' : 'issues';
  const apiUrl = `https://api.github.com/repos/${repoSlug}/${endpoint}/${number}`;

  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub API error: ${res.status} for ${repoSlug}#${number}`,
    );
  }

  const data = (await res.json()) as {
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    html_url: string;
  };

  // Fetch recent comments
  const commentsUrl = `https://api.github.com/repos/${repoSlug}/issues/${number}/comments?per_page=${MAX_COMMENTS}&direction=desc`;
  let comments: string[] = [];
  try {
    const commentsRes = await fetch(commentsUrl, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (commentsRes.ok) {
      const commentsData = (await commentsRes.json()) as Array<{
        user: { login: string };
        body: string;
        created_at: string;
      }>;
      comments = commentsData
        .reverse() // chronological order
        .map((c) => {
          const body =
            c.body.length > MAX_COMMENT_CHARS
              ? c.body.slice(0, MAX_COMMENT_CHARS) + '...'
              : c.body;
          return `${c.user.login} (${c.created_at.split('T')[0]}): ${body}`;
        });
    }
  } catch {
    // Comments are optional — don't fail the whole fetch
  }

  const labels = data.labels.map((l) => l.name);
  const typeHint = inferTypeFromLabels(labels);

  return {
    title: data.title,
    body: truncate(data.body || '', MAX_BODY_CHARS),
    labels,
    comments,
    typeHint,
    sourceUrl: data.html_url,
  };
}

// --- ADO ---

/**
 * Fetch context from an ADO work item.
 * Uses the ADO REST API with PAT auth.
 */
export async function fetchAdoContext(
  project: string,
  workItemId: number,
  pat: string,
  org: string = 'saratogasandboxes',
): Promise<WorkItemContext> {
  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${workItemId}?$expand=all&api-version=7.1`;
  const authHeader = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

  const res = await fetch(apiUrl, {
    headers: { Authorization: authHeader },
  });

  if (!res.ok) {
    throw new Error(
      `ADO API error: ${res.status} for ${project}#${workItemId}`,
    );
  }

  const data = (await res.json()) as {
    fields: Record<string, string | undefined>;
    _links: { html: { href: string } };
  };

  const fields = data.fields;
  const title = fields['System.Title'] || '';
  const description = fields['System.Description'] || '';
  const acceptanceCriteria =
    fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
  const reproSteps = fields['Microsoft.VSTS.TCM.ReproSteps'] || '';
  const tags = (fields['System.Tags'] || '')
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);
  const workItemType = fields['System.WorkItemType'] || '';

  // Build body from available fields
  const bodyParts: string[] = [];
  if (description) bodyParts.push(stripHtml(description));
  if (acceptanceCriteria)
    bodyParts.push(
      `\n**Acceptance Criteria:**\n${stripHtml(acceptanceCriteria)}`,
    );
  if (reproSteps)
    bodyParts.push(`\n**Repro Steps:**\n${stripHtml(reproSteps)}`);

  // Fetch comments
  let comments: string[] = [];
  try {
    const commentsUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${workItemId}/comments?$top=${MAX_COMMENTS}&api-version=7.1-preview.4`;
    const commentsRes = await fetch(commentsUrl, {
      headers: { Authorization: authHeader },
    });
    if (commentsRes.ok) {
      const commentsData = (await commentsRes.json()) as {
        comments: Array<{
          text: string;
          createdBy: { displayName: string };
          createdDate: string;
        }>;
      };
      comments = (commentsData.comments || []).map((c) => {
        const text = stripHtml(c.text);
        const body =
          text.length > MAX_COMMENT_CHARS
            ? text.slice(0, MAX_COMMENT_CHARS) + '...'
            : text;
        return `${c.createdBy.displayName} (${c.createdDate.split('T')[0]}): ${body}`;
      });
    }
  } catch {
    // Comments are optional
  }

  const typeHint = adoTypeToHint(workItemType);

  return {
    title,
    body: truncate(bodyParts.join('\n'), MAX_BODY_CHARS),
    labels: tags,
    comments,
    typeHint,
    sourceUrl:
      data._links?.html?.href ||
      `https://dev.azure.com/${org}/${project}/_workitems/edit/${workItemId}`,
  };
}

// --- Unified fetcher ---

/**
 * Fetch work item context from any supported source.
 * Requires appropriate token to be passed.
 */
export async function fetchWorkItemContext(
  parsed: ParsedWorkItem,
  tokens: { githubToken?: string; adoPat?: string },
): Promise<WorkItemContext> {
  if (parsed.source === 'github') {
    if (!tokens.githubToken) {
      throw new Error('GitHub token required to fetch issue context');
    }
    return fetchGitHubContext(
      parsed.repoSlug,
      parsed.number,
      parsed.type === 'pull_request' ? 'pull_request' : 'issue',
      tokens.githubToken,
    );
  }

  if (parsed.source === 'ado') {
    if (!tokens.adoPat) {
      throw new Error('ADO PAT required to fetch work item context');
    }
    return fetchAdoContext(
      parsed.repoSlug,
      parsed.number,
      tokens.adoPat,
      parsed.adoOrg,
    );
  }

  throw new Error(`Unsupported work item source: ${parsed.source}`);
}

/**
 * Format work item context into a goal string for the fleet.
 */
export function formatGoal(
  context: WorkItemContext,
  userDescription?: string,
): string {
  const parts: string[] = [];

  // User's additional description takes priority
  if (userDescription) {
    parts.push(userDescription);
    parts.push('');
  }

  parts.push(`## ${context.title}`);
  parts.push(`Source: ${context.sourceUrl}`);

  if (context.labels.length > 0) {
    parts.push(`Labels: ${context.labels.join(', ')}`);
  }

  if (context.body) {
    parts.push('');
    parts.push(context.body);
  }

  if (context.comments.length > 0) {
    parts.push('');
    parts.push('### Recent discussion');
    for (const comment of context.comments) {
      parts.push(`- ${comment}`);
    }
  }

  return parts.join('\n');
}

/**
 * Suggest agent composition based on work item type.
 */
export function suggestAgents(context: WorkItemContext): string {
  switch (context.typeHint) {
    case 'bug':
      return 'super,eng1,qa1';
    case 'feature':
      return 'super,eng1,eng2,qa1';
    case 'task':
      return 'super,eng1,qa1';
    default:
      return 'super,eng1,qa1';
  }
}

// --- Helpers ---

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n...(truncated)';
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inferTypeFromLabels(labels: string[]): WorkItemContext['typeHint'] {
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.some((l) => l.includes('bug') || l.includes('defect')))
    return 'bug';
  if (lower.some((l) => l.includes('feature') || l.includes('enhancement')))
    return 'feature';
  if (lower.some((l) => l.includes('task') || l.includes('chore')))
    return 'task';
  return 'unknown';
}

function adoTypeToHint(workItemType: string): WorkItemContext['typeHint'] {
  const lower = workItemType.toLowerCase();
  if (lower.includes('bug')) return 'bug';
  if (lower.includes('user story') || lower.includes('feature'))
    return 'feature';
  if (lower.includes('task')) return 'task';
  return 'unknown';
}
