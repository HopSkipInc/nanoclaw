import { describe, it, expect } from 'vitest';
import { parseWorkItem, extractDescription } from './work-item-parser.js';

describe('parseWorkItem', () => {
  it('parses GitHub issue URL', () => {
    const result = parseWorkItem(
      'https://github.com/HopSkipInc/ai-fleet/issues/55',
    );
    expect(result).toEqual({
      source: 'github',
      repoSlug: 'HopSkipInc/ai-fleet',
      number: 55,
      type: 'issue',
    });
  });

  it('parses GitHub PR URL', () => {
    const result = parseWorkItem(
      'https://github.com/HopSkipInc/ai-fleet/pull/56',
    );
    expect(result).toEqual({
      source: 'github',
      repoSlug: 'HopSkipInc/ai-fleet',
      number: 56,
      type: 'pull_request',
    });
  });

  it('parses ADO new URL (dev.azure.com)', () => {
    const result = parseWorkItem(
      'https://dev.azure.com/saratogasandboxes/Doorbell/_workitems/edit/7300',
    );
    expect(result).toEqual({
      source: 'ado',
      repoSlug: 'Doorbell',
      number: 7300,
      type: 'work_item',
      adoOrg: 'saratogasandboxes',
    });
  });

  it('parses ADO old URL (visualstudio.com)', () => {
    const result = parseWorkItem(
      'https://saratogasandboxes.visualstudio.com/Doorbell/_workitems/edit/7300',
    );
    expect(result).toEqual({
      source: 'ado',
      repoSlug: 'Doorbell',
      number: 7300,
      type: 'work_item',
      adoOrg: 'saratogasandboxes',
    });
  });

  it('parses Slack-wrapped URL', () => {
    const result = parseWorkItem(
      '<https://github.com/HopSkipInc/ai-fleet/issues/55|github.com/HopSkipInc/ai-fleet/issues/55>',
    );
    expect(result).toEqual({
      source: 'github',
      repoSlug: 'HopSkipInc/ai-fleet',
      number: 55,
      type: 'issue',
    });
  });

  it('parses Slack-wrapped URL without display text', () => {
    const result = parseWorkItem(
      '<https://github.com/HopSkipInc/ai-fleet/issues/55>',
    );
    expect(result).toEqual({
      source: 'github',
      repoSlug: 'HopSkipInc/ai-fleet',
      number: 55,
      type: 'issue',
    });
  });

  it('parses GitHub shorthand', () => {
    const result = parseWorkItem('HopSkipInc/ai-fleet #55');
    expect(result).toEqual({
      source: 'github',
      repoSlug: 'HopSkipInc/ai-fleet',
      number: 55,
      type: 'issue',
    });
  });

  it('parses ADO shorthand with US- prefix', () => {
    const result = parseWorkItem('ado:Doorbell/MVP US-7300');
    expect(result).toEqual({
      source: 'ado',
      repoSlug: 'Doorbell/MVP',
      number: 7300,
      type: 'work_item',
    });
  });

  it('parses ADO shorthand with BUG- prefix', () => {
    const result = parseWorkItem('ado:Doorbell BUG-1234');
    expect(result).toEqual({
      source: 'ado',
      repoSlug: 'Doorbell',
      number: 1234,
      type: 'work_item',
    });
  });

  it('parses ADO shorthand with bare number', () => {
    const result = parseWorkItem('ado:Doorbell 7300');
    expect(result).toEqual({
      source: 'ado',
      repoSlug: 'Doorbell',
      number: 7300,
      type: 'work_item',
    });
  });

  it('returns null for non-work-item text', () => {
    expect(parseWorkItem('just some random text')).toBeNull();
    expect(parseWorkItem('fix the login bug')).toBeNull();
  });

  it('handles URL with surrounding text', () => {
    const result = parseWorkItem(
      'check out https://github.com/HopSkipInc/ai-fleet/issues/55 please',
    );
    expect(result?.number).toBe(55);
    expect(result?.repoSlug).toBe('HopSkipInc/ai-fleet');
  });
});

describe('extractDescription', () => {
  it('extracts remaining text after URL', () => {
    const parsed = parseWorkItem(
      'https://github.com/HopSkipInc/ai-fleet/issues/55 fix the verification checklist',
    )!;
    const desc = extractDescription(
      'https://github.com/HopSkipInc/ai-fleet/issues/55 fix the verification checklist',
      parsed,
    );
    expect(desc).toBe('fix the verification checklist');
  });

  it('returns empty for URL-only input', () => {
    const parsed = parseWorkItem(
      'https://github.com/HopSkipInc/ai-fleet/issues/55',
    )!;
    const desc = extractDescription(
      'https://github.com/HopSkipInc/ai-fleet/issues/55',
      parsed,
    );
    expect(desc).toBe('');
  });

  it('extracts description after shorthand', () => {
    const parsed = parseWorkItem(
      'HopSkipInc/ai-fleet #55 add the checklist section',
    )!;
    const desc = extractDescription(
      'HopSkipInc/ai-fleet #55 add the checklist section',
      parsed,
    );
    expect(desc).toBe('add the checklist section');
  });
});
