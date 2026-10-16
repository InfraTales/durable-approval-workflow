import { requireEnv, requirePositiveInt } from '../../app/src/config';
import { formatAmount, isDecision, parseExpenseRequest, ValidationError } from '../../app/src/domain';
import { hashToken, newApprovalToken } from '../../app/src/token';

const good = { requestId: 'exp-1', requester: 'ana@example.com', amountCents: 12_000, description: 'Flight' };

test('a valid request parses and trims text', () => {
  expect(parseExpenseRequest({ ...good, description: '  Flight  ', extra: 'ignored' })).toEqual(good);
});

test.each([
  ['not an object', 'x'],
  ['an array', [good]],
  ['a request ID with a slash', { ...good, requestId: 'a/b' }],
  ['a request ID over 64 characters', { ...good, requestId: 'a'.repeat(65) }],
  ['a fractional amount', { ...good, amountCents: 10.5 }],
  ['a zero amount', { ...good, amountCents: 0 }],
  ['a negative amount', { ...good, amountCents: -1 }],
  ['an amount as a string', { ...good, amountCents: '100' }],
  ['an amount over $100,000', { ...good, amountCents: 10_000_001 }],
  ['an empty requester', { ...good, requester: '   ' }],
  ['a description over 500 characters', { ...good, description: 'x'.repeat(501) }],
])('rejects %s', (_label, input) => {
  expect(() => parseExpenseRequest(input)).toThrow(ValidationError);
});

test('decisions are exactly APPROVED or REJECTED', () => {
  expect(isDecision('APPROVED')).toBe(true);
  expect(isDecision('REJECTED')).toBe(true);
  expect(isDecision('approved')).toBe(false);
  expect(isDecision('EXPIRED')).toBe(false);
});

test('amounts format as dollars', () => {
  expect(formatAmount(12_000)).toBe('$120.00');
  expect(formatAmount(5)).toBe('$0.05');
});

test('tokens are 256 random bits, and only their SHA-256 is stored', () => {
  const a = newApprovalToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(newApprovalToken()).not.toBe(a);
  expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  expect(hashToken(a)).toBe(hashToken(a));
});

test('config fails fast on missing or bad values', () => {
  delete process.env.NOPE;
  expect(() => requireEnv('NOPE')).toThrow('Missing required environment variable NOPE');
  process.env.NOPE = ' ';
  expect(() => requireEnv('NOPE')).toThrow();
  process.env.NOPE = '1.5';
  expect(() => requirePositiveInt('NOPE')).toThrow('positive whole number');
  process.env.NOPE = '0';
  expect(() => requirePositiveInt('NOPE')).toThrow();
  process.env.NOPE = '259200';
  expect(requirePositiveInt('NOPE')).toBe(259200);
});
