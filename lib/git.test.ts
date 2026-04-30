import { describe, expect, test } from 'bun:test';
import { isTransientGhError } from './git';

describe('isTransientGhError', () => {
  test.each([
    'dial tcp: connection refused',
    'read: connection reset by peer',
    'i/o timeout',
    'context deadline exceeded',
    'HTTP 502: Bad Gateway',
    'HTTP 503',
    'HTTP 504: Gateway Timeout',
    'unexpected EOF',
    'network is unreachable',
    'temporary failure in name resolution',
  ])('classifies %p as transient', (msg) => {
    expect(isTransientGhError(msg)).toBe(true);
  });

  test.each([
    '',
    'no checks reported on the X branch',
    'authentication required',
    'GraphQL: Could not resolve to a PullRequest with the number of 999',
    'permission denied',
    'pull request already exists for branch',
  ])('classifies %p as non-transient', (msg) => {
    expect(isTransientGhError(msg)).toBe(false);
  });
});
