import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { type ApprovalItem, ApprovalStore } from '../../app/src/store';
import { hashToken } from '../../app/src/token';

// How claimDecision reads a failed condition. test/flow/store.test.ts runs the same cases
// against DynamoDB Local; this file covers the branching without Docker.
const ddb = mockClient(DynamoDBDocumentClient);
const store = new ApprovalStore('approvals');
const h = hashToken('a-token-the-approver-got');
const AFTER_DEADLINE = '2026-10-18T10:00:01.000Z';

const item = (over: Partial<ApprovalItem>): ApprovalItem => ({
  requestId: 'r-1',
  requester: 'ana',
  amountCents: 9_900,
  description: 'Desk',
  status: 'PENDING',
  submittedAt: '2026-10-15T10:00:00.000Z',
  callbackId: 'cb-r-1',
  tokenHash: h,
  expiresAt: '2026-10-18T10:00:00.000Z',
  ...over,
});
const failWith = (old: ApprovalItem) =>
  ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'failed', $metadata: {}, Item: marshall(old) }));

beforeEach(() => ddb.reset());

test.each<[string, Partial<ApprovalItem>, 'APPROVED' | 'REJECTED', string]>([
  ['same decision claimed in time, retried after the deadline', { decision: 'APPROVED' }, 'APPROVED', 'already-claimed'],
  ['other decision claimed in time, tried after the deadline', { decision: 'APPROVED' }, 'REJECTED', 'conflict'],
  ['nothing claimed, tried after the deadline', {}, 'APPROVED', 'closed'],
  ['same decision already final', { decision: 'APPROVED', status: 'APPROVED' }, 'APPROVED', 'already-final'],
  ['expired with no claim', { status: 'EXPIRED' }, 'APPROVED', 'closed'],
  ['auto-approved', { status: 'AUTO_APPROVED' }, 'APPROVED', 'closed'],
])('%s: %j + %s is %s', async (_label, over, decision, kind) => {
  failWith(item(over));
  expect((await store.claimDecision('r-1', h, decision, AFTER_DEADLINE)).kind).toBe(kind);
});

test('a wrong token never learns anything, even about a claimed request', async () => {
  failWith(item({ decision: 'APPROVED' }));
  expect(await store.claimDecision('r-1', hashToken('guess'), 'APPROVED', AFTER_DEADLINE)).toEqual({ kind: 'not-found' });
});
