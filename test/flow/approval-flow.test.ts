import { LocalDurableTestRunner } from '@aws/durable-execution-sdk-js-testing';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { handler as decide } from '../../app/src/decide-handler';
import { ApprovalStore } from '../../app/src/store';
import { handler as submit } from '../../app/src/submit-handler';
import { handler as workflow } from '../../app/src/workflow-handler';
import { DurableBridge } from '../support/durable-bridge';
import { urlEvent } from '../support/events';
import { createTable, deleteTable } from '../support/table';

// Everything here is real except AWS itself: the three handler modules as Lambda loads them,
// the official local durable runner, and DynamoDB Local. Only SNS and the Lambda API are faked.
const tableName = process.env.APPROVALS_TABLE!;
const bridge = new DurableBridge(workflow);
const store = new ApprovalStore(tableName);
let ddb: DynamoDBClient;
let n = 0;

beforeAll(async () => {
  ddb = await createTable(tableName);
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
  await deleteTable(ddb, tableName);
});
beforeEach(() => bridge.reset());

const expense = (amountCents = 12_000) => ({
  requestId: `exp-${++n}-${Date.now()}`,
  requester: 'ana@example.com',
  amountCents,
  description: 'Flight to the team offsite',
});

async function submitExpense(body: ReturnType<typeof expense>) {
  const res = await submit(urlEvent('POST', body));
  expect(res.statusCode).toBe(202);
  return body.requestId;
}

const decideAs = (requestId: string, token: string, decision: string) => decide(urlEvent('POST', { requestId, token, decision }));

test('approve: the workflow waits for the approver, then records APPROVED', async () => {
  const requestId = await submitExpense(expense());
  const token = await bridge.approverToken();
  expect((await store.get(requestId))?.status).toBe('PENDING');

  const res = await decideAs(requestId, token, 'APPROVED');
  expect(res.statusCode).toBe(200);

  const execution = await bridge.result();
  expect(execution.getStatus()).toBe('SUCCEEDED');
  expect(execution.getResult()).toEqual({ requestId, outcome: 'APPROVED' });
  expect((await store.get(requestId))?.status).toBe('APPROVED');
  expect(bridge.published.map((p) => p.kind)).toEqual(['approval-request', 'outcome']);
});

test('reject: a rejection is a normal outcome, not a failed execution', async () => {
  const requestId = await submitExpense(expense());
  const token = await bridge.approverToken();
  expect((await decideAs(requestId, token, 'REJECTED')).statusCode).toBe(200);

  const execution = await bridge.result();
  expect(execution.getStatus()).toBe('SUCCEEDED');
  expect(execution.getResult()).toEqual({ requestId, outcome: 'REJECTED' });
  expect((await store.get(requestId))?.status).toBe('REJECTED');
});

test('duplicate callback: a double click is harmless, a change of mind is refused', async () => {
  const requestId = await submitExpense(expense());
  const token = await bridge.approverToken();

  const [first, second] = await Promise.all([decideAs(requestId, token, 'APPROVED'), decideAs(requestId, token, 'APPROVED')]);
  expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
  expect((await decideAs(requestId, token, 'REJECTED')).statusCode).toBe(409);

  const execution = await bridge.result();
  expect(execution.getResult()).toEqual({ requestId, outcome: 'APPROVED' });
  // A click after the workflow finished still answers 200 for the same decision, 409 for the other.
  expect((await decideAs(requestId, token, 'APPROVED')).statusCode).toBe(200);
  expect((await decideAs(requestId, token, 'REJECTED')).statusCode).toBe(409);
  expect(bridge.published.filter((p) => p.kind === 'outcome')).toHaveLength(1);
});

test('wrong token, wrong method and bad input never reach the workflow', async () => {
  const requestId = await submitExpense(expense());
  await bridge.approverToken();

  expect((await decideAs(requestId, 'x'.repeat(43), 'APPROVED')).statusCode).toBe(404);
  expect((await decide(urlEvent('GET'))).statusCode).toBe(405);
  expect((await decide(urlEvent('POST', 'not json'))).statusCode).toBe(400);
  expect((await decideAs(requestId, 'x'.repeat(43), 'MAYBE')).statusCode).toBe(400);
  expect(bridge.callbacksSent).toBe(0);
  expect((await store.get(requestId))?.decision).toBeUndefined();
});

test('small amounts are approved without a human and without a callback', async () => {
  const requestId = await submitExpense(expense(5_000));
  const execution = await bridge.result();
  expect(execution.getResult()).toEqual({ requestId, outcome: 'AUTO_APPROVED' });
  expect(execution.getOperations().map((op) => op.getName())).toEqual(['record-request', 'auto-approve', 'announce-outcome']);
  expect(bridge.published.map((p) => p.kind)).toEqual(['outcome']);
});

test('the table stores a hash of the token, never the token or anything that can approve', async () => {
  const requestId = await submitExpense(expense());
  const token = await bridge.approverToken();
  const item = await store.get(requestId);
  expect(JSON.stringify(item)).not.toContain(token);
  expect(item?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  await decideAs(requestId, token, 'REJECTED');
  await bridge.result();
});
