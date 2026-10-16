import {
  CallbackTimeoutException,
  DurableExecutionAlreadyStartedException,
  InvokeCommand,
  LambdaClient,
  SendDurableExecutionCallbackSuccessCommand,
  ServiceException,
} from '@aws-sdk/client-lambda';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { createDecisionHandler } from '../../app/src/decide';
import { Notifier } from '../../app/src/notifier';
import type { ClaimResult } from '../../app/src/store';
import { createSubmitHandler } from '../../app/src/submit';
import { hashToken } from '../../app/src/token';
import { urlEvent } from '../support/events';

const lambda = mockClient(LambdaClient);
const sns = mockClient(SNSClient);
const meta = { $metadata: {} };
beforeEach(() => {
  lambda.reset();
  sns.reset();
});

const expense = { requestId: 'exp-1', requester: 'ana@example.com', amountCents: 12_000, description: 'Flight' };
const ALIAS = 'arn:aws:lambda:us-east-1:123456789012:function:wf:live';

describe('submit', () => {
  const submit = createSubmitHandler({ lambda: new LambdaClient({}), workflowArn: ALIAS });

  test('starts one async durable execution named after the request ID', async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
    expect((await submit(urlEvent('POST', expense))).statusCode).toBe(202);
    const input = lambda.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ FunctionName: ALIAS, InvocationType: 'Event', DurableExecutionName: 'exp-1' });
    expect(JSON.parse(Buffer.from(input.Payload as Uint8Array).toString())).toEqual(expense);
  });

  test('the same request ID with different content is a 409', async () => {
    lambda.on(InvokeCommand).rejects(new DurableExecutionAlreadyStartedException({ message: 'exists', ...meta }));
    expect((await submit(urlEvent('POST', expense))).statusCode).toBe(409);
  });

  test('bad input is a 400 and never invokes anything', async () => {
    expect((await submit(urlEvent('POST', { ...expense, amountCents: -5 }))).statusCode).toBe(400);
    expect((await submit(urlEvent('PUT', expense))).statusCode).toBe(405);
    expect((await submit(urlEvent('POST', '{'))).statusCode).toBe(400);
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test('an AWS error is a 502 that tells the client to retry with the same ID', async () => {
    lambda.on(InvokeCommand).rejects(new ServiceException({ message: 'boom', ...meta }));
    const res = await submit(urlEvent('POST', expense));
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('same requestId');
  });
});

describe('decide', () => {
  const token = 'tok'.repeat(15);
  const claims: { args: unknown[] }[] = [];
  const handlerWith = (result: ClaimResult) =>
    createDecisionHandler({
      store: {
        claimDecision: async (...args: unknown[]) => {
          claims.push({ args });
          return result;
        },
      },
      lambda: new LambdaClient({}),
      clock: () => new Date('2026-10-15T12:00:00Z'),
    });
  const body = { requestId: 'exp-1', token, decision: 'APPROVED' };
  beforeEach(() => (claims.length = 0));

  test('a claim sends the stored callback ID, never anything from the request', async () => {
    lambda.on(SendDurableExecutionCallbackSuccessCommand).resolves({});
    const res = await handlerWith({ kind: 'claimed', callbackId: 'cb-123' })(urlEvent('POST', body, true));
    expect(res.statusCode).toBe(200);
    expect(claims[0]!.args).toEqual(['exp-1', hashToken(token), 'APPROVED', '2026-10-15T12:00:00.000Z']);
    const sent = lambda.commandCalls(SendDurableExecutionCallbackSuccessCommand)[0]!.args[0].input;
    expect(sent.CallbackId).toBe('cb-123');
    expect(JSON.parse(Buffer.from(sent.Result as Uint8Array).toString())).toEqual({ decision: 'APPROVED' });
  });

  test('a callback that already closed is still a 200: the claim is in DynamoDB', async () => {
    lambda.on(SendDurableExecutionCallbackSuccessCommand).rejects(new CallbackTimeoutException({ message: 'closed', ...meta }));
    expect((await handlerWith({ kind: 'claimed', callbackId: 'cb-123' })(urlEvent('POST', body))).statusCode).toBe(200);
  });

  test('any other callback error is a 502, so the approver retries', async () => {
    lambda.on(SendDurableExecutionCallbackSuccessCommand).rejects(new ServiceException({ message: 'boom', ...meta }));
    expect((await handlerWith({ kind: 'claimed', callbackId: 'cb-123' })(urlEvent('POST', body))).statusCode).toBe(502);
  });

  test.each<[ClaimResult, number]>([
    [{ kind: 'not-found' }, 404],
    [{ kind: 'conflict', decision: 'REJECTED' }, 409],
    [{ kind: 'closed' }, 410],
    [{ kind: 'already-final' }, 200],
  ])('claim %j answers %i without sending a callback', async (claim, status) => {
    expect((await handlerWith(claim)(urlEvent('POST', body))).statusCode).toBe(status);
    expect(lambda.commandCalls(SendDurableExecutionCallbackSuccessCommand)).toHaveLength(0);
  });

  test('GET is refused, so a mail scanner that opens links approves nothing', async () => {
    expect((await handlerWith({ kind: 'claimed', callbackId: 'cb' })(urlEvent('GET'))).statusCode).toBe(405);
    expect(claims).toHaveLength(0);
  });

  test('oversized and malformed bodies are 4xx', async () => {
    const h = handlerWith({ kind: 'claimed', callbackId: 'cb' });
    expect((await h(urlEvent('POST', { ...body, pad: 'x'.repeat(5000) }))).statusCode).toBe(413);
    expect((await h(urlEvent('POST', 'null'))).statusCode).toBe(400);
    expect((await h(urlEvent('POST', { ...body, token: 'short' }))).statusCode).toBe(400);
    expect((await h(urlEvent('POST', { ...body, decision: 'approved' }))).statusCode).toBe(400);
    expect(claims).toHaveLength(0);
  });
});

describe('notifier', () => {
  const notifier = new Notifier('arn:aws:sns:us-east-1:123456789012:t', 'https://decide.example.com/', new SNSClient({}));

  test('the approval email gives POST commands with the token, not clickable approve links', async () => {
    sns.on(PublishCommand).resolves({ MessageId: 'm' });
    await notifier.requestApproval(expense, 'the-token', '2026-10-18T12:00:00.000Z');
    const input = sns.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.Message).toContain("curl -X POST https://decide.example.com/");
    expect(input.Message).toContain('"token":"the-token"');
    expect(input.Message).not.toMatch(/https:\/\/\S+\?/); // no token in a query string
    expect(input.MessageAttributes?.kind?.StringValue).toBe('approval-request');
  });

  test('subjects stay within what SNS accepts', async () => {
    sns.on(PublishCommand).resolves({ MessageId: 'm' });
    await notifier.announceOutcome({ ...expense, requestId: 'é'.repeat(64) + 'x'.repeat(60) }, 'APPROVED');
    const subject = sns.commandCalls(PublishCommand)[0]!.args[0].input.Subject!;
    expect(subject.length).toBeLessThanOrEqual(100);
    expect(subject).toMatch(/^[\x20-\x7e]+$/);
  });
});
