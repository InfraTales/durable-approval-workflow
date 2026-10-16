import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ApprovalStore, StoreConflictError } from '../../app/src/store';
import { hashToken } from '../../app/src/token';
import { createTable, deleteTable } from '../support/table';

// Every condition expression runs against DynamoDB Local, not a fake.
const tableName = process.env.APPROVALS_TABLE!;
const store = new ApprovalStore(tableName);
let ddb: DynamoDBClient;
let n = 0;

beforeAll(async () => {
  ddb = await createTable(tableName);
});
afterAll(() => deleteTable(ddb, tableName));

const T0 = '2026-10-15T10:00:00.000Z';
const BEFORE_DEADLINE = '2026-10-16T10:00:00.000Z';
const DEADLINE = '2026-10-18T10:00:00.000Z';
const AFTER_DEADLINE = '2026-10-18T10:00:01.000Z';
const h = hashToken('a-token-the-approver-got');

async function pending(): Promise<string> {
  const requestId = `s-${++n}`;
  await store.recordRequest({ requestId, requester: 'ana', amountCents: 9_900, description: 'Desk' }, T0);
  await store.attachCallback(requestId, `cb-${requestId}`, h, DEADLINE);
  return requestId;
}

test('recordRequest: a retried step with the same content is fine, different content is refused', async () => {
  const req = { requestId: `s-${++n}`, requester: 'ana', amountCents: 100, description: 'Pens' };
  expect(await store.recordRequest(req, T0)).toEqual({ submittedAt: T0 });
  expect(await store.recordRequest(req, BEFORE_DEADLINE)).toEqual({ submittedAt: T0 });
  await expect(store.recordRequest({ ...req, amountCents: 999_999 }, T0)).rejects.toBeInstanceOf(StoreConflictError);
});

test('claimDecision: approve and reject at the same moment, exactly one wins', async () => {
  for (let round = 0; round < 10; round++) {
    const id = await pending();
    const results = await Promise.all([
      store.claimDecision(id, h, 'APPROVED', BEFORE_DEADLINE),
      store.claimDecision(id, h, 'REJECTED', BEFORE_DEADLINE),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['claimed', 'conflict']);
  }
});

test('claimDecision: wrong token, unknown request and a passed deadline are all refused', async () => {
  const id = await pending();
  expect(await store.claimDecision(id, hashToken('guess'), 'APPROVED', BEFORE_DEADLINE)).toEqual({ kind: 'not-found' });
  expect(await store.claimDecision('nope', h, 'APPROVED', BEFORE_DEADLINE)).toEqual({ kind: 'not-found' });
  expect(await store.claimDecision(id, h, 'APPROVED', DEADLINE)).toEqual({ kind: 'closed' });
  expect(await store.claimDecision(id, h, 'APPROVED', AFTER_DEADLINE)).toEqual({ kind: 'closed' });
  expect((await store.get(id))?.decision).toBeUndefined();
});

test('claimDecision: the same decision twice returns the callback ID again, for a retry', async () => {
  const id = await pending();
  expect(await store.claimDecision(id, h, 'APPROVED', BEFORE_DEADLINE)).toEqual({ kind: 'claimed', callbackId: `cb-${id}` });
  expect(await store.claimDecision(id, h, 'APPROVED', BEFORE_DEADLINE)).toEqual({ kind: 'claimed', callbackId: `cb-${id}` });
  expect(await store.finalizeFromClaim(id, BEFORE_DEADLINE)).toBe('APPROVED');
  expect(await store.finalizeFromClaim(id, BEFORE_DEADLINE)).toBe('APPROVED'); // the step retried
  expect(await store.claimDecision(id, h, 'APPROVED', BEFORE_DEADLINE)).toEqual({ kind: 'already-final' });
  expect(await store.claimDecision(id, h, 'REJECTED', BEFORE_DEADLINE)).toEqual({ kind: 'conflict', decision: 'APPROVED' });
});

test('expire vs claim: whichever conditional write lands first decides', async () => {
  const expiredFirst = await pending();
  expect(await store.expire(expiredFirst, AFTER_DEADLINE)).toBe('EXPIRED');
  expect(await store.expire(expiredFirst, AFTER_DEADLINE)).toBe('EXPIRED'); // the step retried
  expect(await store.claimDecision(expiredFirst, h, 'APPROVED', BEFORE_DEADLINE)).toEqual({ kind: 'closed' });

  const claimedFirst = await pending();
  expect((await store.claimDecision(claimedFirst, h, 'REJECTED', BEFORE_DEADLINE)).kind).toBe('claimed');
  expect(await store.expire(claimedFirst, AFTER_DEADLINE)).toBe('REJECTED');
  expect((await store.get(claimedFirst))?.status).toBe('REJECTED');
});

test('expire and claim racing: the final status always matches the winner', async () => {
  for (let round = 0; round < 10; round++) {
    const id = await pending();
    const [claim, expired] = await Promise.all([
      store.claimDecision(id, h, 'APPROVED', BEFORE_DEADLINE),
      store.expire(id, AFTER_DEADLINE),
    ]);
    const item = await store.get(id);
    if (claim.kind === 'claimed') {
      expect(expired).toBe('APPROVED');
      expect(item?.status).toBe('APPROVED');
    } else {
      expect(claim.kind).toBe('closed');
      expect(expired).toBe('EXPIRED');
      expect(item?.status).toBe('EXPIRED');
    }
  }
});

test('autoApprove only moves a pending request, and is safe to repeat', async () => {
  const req = { requestId: `s-${++n}`, requester: 'ana', amountCents: 100, description: 'Pens' };
  await store.recordRequest(req, T0);
  expect(await store.autoApprove(req.requestId, T0)).toBe('AUTO_APPROVED');
  expect(await store.autoApprove(req.requestId, T0)).toBe('AUTO_APPROVED');
  const other = await pending();
  await store.expire(other, AFTER_DEADLINE);
  await expect(store.autoApprove(other, T0)).rejects.toThrow();
});

test('attachCallback refuses to overwrite a request that already has a decision', async () => {
  const id = await pending();
  await store.claimDecision(id, h, 'APPROVED', BEFORE_DEADLINE);
  await expect(store.attachCallback(id, 'cb-new', hashToken('new'), DEADLINE)).rejects.toThrow();
});

test('finalizeFromClaim refuses a request nobody has claimed', async () => {
  const id = await pending();
  await expect(store.finalizeFromClaim(id, BEFORE_DEADLINE)).rejects.toThrow();
  expect((await store.get(id))?.status).toBe('PENDING');
});
