import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js';
import { LocalDurableTestRunner } from '@aws/durable-execution-sdk-js-testing';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { handler as decide } from '../../app/src/decide-handler';
import { ApprovalStore } from '../../app/src/store';
import { handler as submit } from '../../app/src/submit-handler';
import { handler as workflow } from '../../app/src/workflow-handler';
import { DurableBridge } from '../support/durable-bridge';
import { urlEvent } from '../support/events';
import { createTable, deleteTable } from '../support/table';

const tableName = process.env.APPROVALS_TABLE!;
const store = new ApprovalStore(tableName);
const bridge = new DurableBridge(workflow);
let ddb: DynamoDBClient;

beforeAll(async () => {
  ddb = await createTable(tableName);
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
  await deleteTable(ddb, tableName);
});
beforeEach(() => bridge.reset());

test('replay: extra invocations rerun the code but never the finished side effects', async () => {
  const requestId = `replay-${Date.now()}`;
  expect((await submit(urlEvent('POST', { requestId, requester: 'ana@example.com', amountCents: 12_000, description: 'Laptop' }))).statusCode).toBe(202);
  bridge.failPublishes = 1; // the approval email fails once, so the submitter step retries
  const token = await bridge.approverToken();
  const submittedAt = (await store.get(requestId))?.submittedAt;

  expect((await decide(urlEvent('POST', { requestId, token, decision: 'APPROVED' }))).statusCode).toBe(200);
  const execution = await bridge.result();

  expect(execution.getResult()).toEqual({ requestId, outcome: 'APPROVED' });
  // The retry and the callback each started a fresh invocation that replayed from the top.
  expect(execution.getInvocations().length).toBeGreaterThanOrEqual(3);
  expect(bridge.publishAttempts).toBe(3);
  // One approval email and one outcome email, however many times the handler ran.
  expect(bridge.published.map((p) => p.kind)).toEqual(['approval-request', 'outcome']);
  expect((await store.get(requestId))?.submittedAt).toBe(submittedAt);
  // The operation log is the same shape every run: this is what replay matches against.
  // waitForCallback is three operations: a context, the callback, and the submitter step.
  expect(execution.getOperations().map((op) => op.getName() ?? '(inside manager-approval)')).toEqual([
    'record-request',
    'manager-approval',
    '(inside manager-approval)',
    '(inside manager-approval)',
    'finalize',
    'announce-outcome',
  ]);
});

test('replay: the SDK fails an execution whose code takes a different path on replay', async () => {
  // A deliberately broken workflow: it branches on something outside a step (here, how many
  // times it has run; in real code, Date.now() or a config read). The SDK refuses to guess.
  let invocations = 0;
  const broken = withDurableExecution(async (_event: unknown, ctx: DurableContext) => {
    invocations += 1;
    // The branch runs before the wait, so the replay meets a checkpoint written by the other path.
    // (Branching after the last checkpoint is harmless: nothing recorded yet disagrees with it.)
    const result = invocations === 1 ? await ctx.step('path-a', async () => 'a') : await ctx.step('path-b', async () => 'b');
    await ctx.wait('pause', { hours: 1 });
    return result;
  });
  const runner = new LocalDurableTestRunner({ handlerFunction: broken });
  const failed = await runner.run({ payload: {} });
  expect(invocations).toBeGreaterThanOrEqual(2);
  expect(failed.getStatus()).toBe('FAILED');
  expect(failed.getError()?.errorType).toBe('NonDeterministicExecutionError');

  const sound = withDurableExecution(async (_event: unknown, ctx: DurableContext) => {
    // The fix: make the choice inside a step. Replays read the recorded answer.
    const pathA = await ctx.step('choose-path', async () => invocations % 2 === 0);
    const result = pathA ? await ctx.step('path-a', async () => 'a') : await ctx.step('path-b', async () => 'b');
    await ctx.wait('pause', { hours: 1 });
    return result;
  });
  const ok = await new LocalDurableTestRunner({ handlerFunction: sound }).run({ payload: {} });
  expect(ok.getStatus()).toBe('SUCCEEDED');
});
