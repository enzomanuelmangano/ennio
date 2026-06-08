import { describe, it, expect } from 'vitest';

import { buildCrashIssueUrl } from './crash-reporter';

describe('buildCrashIssueUrl', () => {
  it('targets the bug_report issue-form template (blank issues are disabled)', () => {
    const url = buildCrashIssueUrl(new Error('boom'));
    expect(url.startsWith('https://github.com/enzomanuelmangano/ennio/issues/new?')).toBe(true);
    expect(url).toContain('template=bug_report.yml');
    expect(url).toContain('labels=crash');
  });

  it('pre-fills the form fields by id', () => {
    const url = buildCrashIssueUrl(new Error('socket never came up'));
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('title')).toContain('socket never came up');
    expect(q.get('verbose-output')).toContain('socket never came up');
    expect(q.get('ennio-version')).toBeTruthy();
    expect(q.get('xcode-node')).toContain('Node');
  });

  it('reports Android vs iOS from ENNIO_PLATFORM', () => {
    const prev = process.env.ENNIO_PLATFORM;
    process.env.ENNIO_PLATFORM = 'android';
    const q = new URLSearchParams(buildCrashIssueUrl(new Error('x')).split('?')[1]);
    expect(q.get('simulator')).toContain('Android');
    if (prev === undefined) delete process.env.ENNIO_PLATFORM;
    else process.env.ENNIO_PLATFORM = prev;
  });

  it('handles non-Error throws', () => {
    const url = buildCrashIssueUrl('raw string failure');
    expect(url).toContain('raw+string+failure');
  });
});
