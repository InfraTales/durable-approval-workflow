import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { LocalDurableTestRunner } from '@aws/durable-execution-sdk-js-testing';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { handler as decide } from '../../app/src/decide-handler';
import { Notifier } from '../../app/src/notifier';
import { ApprovalStore } from '../../app/src/store';
import { handler as submit } from '../../app/src/submit-handler';
import { createWorkflow } from '../../app/src/workflow';
import { DurableBridge } from '../support/durable-bridge';
import { urlEvent } from '../support/events';
import { createTable, deleteTable } from '../support/table';

// The local runner's skipTime does not skip callback timeouts: its checkpoint server runs in a
// worker thread with real timers. So this file builds the same workflow with a 2 second deadline
// instead of 3 days. Everything else is the production code.
const tableName = process.env.APPROVALS_TABLE!;
const store = new ApprovalStore(tableName);
const workflow = withDurableExecution(
  createWorkflow({
    store,
    notifier: new Notifier(process.env.TOPIC_ARN!, process.env.DECISION_URL!),
    settings: { autoApproveLimitCents: 5000, approvalTimeoutSeconds: 2 },
  }),
);
const bridge = new DurableBridge(workflow);
let ddb: DynamoDBClient;
let n = 0;

beforeAll(async () => {
  ddb = await createTable(tableName);
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
});
afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
  await deleteTable(ddb, tableName);
});
beforeEach(() => bridge.reset());

async function start(): Promise<{ requestId: string; token: string }> {
  const requestId = `late-${++n}-${Date.now()}`;
  const res = await submit(urlEvent('POST', { requestId, requester: 'ana@example.com', amountCents: 12_000, description: 'Team dinner' }));
  expect(res.statusCode).toBe(202);
  return { requestId, token: await bridge.approverToken() };
}

test('timeout: nobody answers, so the request expires and a late click gets 410', async () => {
  const { requestId, token } = await start();

  const execution = await bridge.result();
  expect(execution.getStatus()).toBe('SUCCEEDED');
  expect(execution.getResult()).toEqual({ requestId, outcome: 'EXPIRED' });
  expect((await store.get(requestId))?.status).toBe('EXPIRED');

  const late = await decide(urlEvent('POST', { requestId, token, decision: 'APPROVED' }));
  expect(late.statusCode).toBe(410);
  expect(bridge.callbacksSent).toBe(0);
  expect(bridge.published.filter((p) => p.kind === 'outcome').map((p) => p.subject)).toEqual([`Expense ${requestId}: EXPIRED`]);
});

test('a claim that lands just before the deadline wins, even when its callback is lost', async () => {
  const { requestId, token } = await start();

  bridge.dropCallbacks = true; // the callback fails with CallbackTimeoutException
  const res = await decide(urlEvent('POST', { requestId, token, decision: 'APPROVED' }));
  expect(res.statusCode).toBe(200);
  expect(bridge.callbacksSent).toBe(1);

  const execution = await bridge.result(); // the callback times out; the expire step finds the claim
  expect(execution.getResult()).toEqual({ requestId, outcome: 'APPROVED' });
  expect((await store.get(requestId))?.status).toBe('APPROVED');
});
