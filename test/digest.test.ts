import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDigestTruncated,
  truncateConversationDigest,
  truncateDigestMessageText,
} from '../src/parsers/digest.ts';

test('truncateConversationDigest keeps short digests unchanged', () => {
  const digest = '[User]: quick ask\n\n[Assistant]: quick response';
  assert.equal(truncateConversationDigest(digest, 200), digest);
});

test('truncateConversationDigest preserves beginning and end of long digests', () => {
  const start = '[User]: start-phase request about parser setup.';
  const end = '[Assistant]: final-phase outcome with key rollout changes.';
  const middle = 'x'.repeat(9000);
  const digest = `${start}\n\n${middle}\n\n${end}`;

  const truncated = truncateConversationDigest(digest, 1200);

  assert.ok(truncated.includes(start));
  assert.ok(truncated.includes(end));
  assert.ok(truncated.includes('[...truncated middle section...]'));
  assert.ok(truncated.length <= 1200);
});

test('truncateDigestMessageText keeps short text and truncates long text', () => {
  assert.equal(truncateDigestMessageText('short', 10), 'short');
  assert.equal(truncateDigestMessageText('x'.repeat(20), 8), 'xxxxxxxx...');
});

test('isDigestTruncated detects digest marker', () => {
  const digest = '[User]: start\n\n[...truncated middle section...]\n\n[Assistant]: end';
  assert.equal(isDigestTruncated(digest), true);
  assert.equal(isDigestTruncated('[User]: full digest'), false);
});
