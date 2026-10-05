import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES, apiErrorMessages, limits } from '../src/index';

// SPEC 14.2 (M4): the admin view's numbers live in config, never in code.
describe('admin config', () => {
  it('opens on a period it offers, and offers 7, 30 and 90 days', () => {
    expect([...limits.admin.periodsDays]).toEqual([7, 30, 90]);
    expect((limits.admin.periodsDays as readonly number[]).includes(limits.admin.defaultPeriodDays)).toBe(true);
  });

  it('has a function-request threshold of at least two different people', () => {
    expect(limits.learn.functionRequests.issueThreshold).toBeGreaterThanOrEqual(2);
    // (the set of owners one request remembers must be able to reach it)
    expect(limits.learn.functionRequests.maxOwnerHashes).toBeGreaterThanOrEqual(limits.learn.functionRequests.issueThreshold);
  });

  it('points the issue link at GitHub\'s new-issue form, with no query of its own', () => {
    const url = new URL(limits.admin.githubNewIssueUrl);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname.endsWith('/issues/new')).toBe(true);
    expect(url.search).toBe('');
  });

  it('only lets an admin override a limit some code reads (aiLearns)', () => {
    expect([...limits.admin.overrideKeys]).toEqual(['aiLearns']);
    expect(limits.admin.maxOverride).toBeGreaterThan(0);
  });

  it('keeps the pages and lists within sensible bounds', () => {
    expect(limits.admin.usersPageSize).toBeLessThanOrEqual(limits.admin.maxUsersPageSize);
    expect(limits.admin.requestsPerIpPerMinute).toBeGreaterThan(0);
  });

  it('says "forbidden" in Hebrew and English', () => {
    expect(API_ERROR_CODES).toContain('forbidden');
    expect(apiErrorMessages.forbidden.en.length).toBeGreaterThan(0);
    expect(apiErrorMessages.forbidden.he.length).toBeGreaterThan(0);
  });
});
