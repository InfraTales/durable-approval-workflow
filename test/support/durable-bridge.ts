import {
  CallbackTimeoutException,
  InvokeCommand,
  LambdaClient,
  ResourceNotFoundException,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { LocalDurableTestRunner, WaitingOperationStatus, type TestResult } from '@aws/durable-execution-sdk-js-testing';
import { mockClient } from 'aws-sdk-client-mock';
import type { WorkflowResult } from '../../app/src/workflow';

const meta = { $metadata: {} };

/**
 * Connects the real handlers the way Lambda does in AWS:
 * - the submit handler's Invoke starts an execution in the official local durable test runner;
 * - the decision handler's SendDurableExecutionCallbackSuccess completes that execution's callback.
 * The local runner accepts a callback twice without complaint. The real API answers a closed
 * callback with CallbackTimeoutException, so the bridge does the same.
 */
export class DurableBridge {
  readonly lambda = mockClient(LambdaClient);
  readonly sns = mockClient(SNSClient);
  readonly published: { subject: string; message: string; kind: string }[] = [];
  runner!: LocalDurableTestRunner<WorkflowResult>;
  execution?: Promise<TestResult<WorkflowResult>>;
  callbacksSent = 0;
  /** When true, callbacks are lost on the way, as if the deadline had just passed. */
  dropCallbacks = false;
  /** How many of the next SNS publishes fail, like a brief SNS outage. */
  failPublishes = 0;
  publishAttempts = 0;
  private readonly closed = new Set<string>();

  constructor(private readonly handlerFunction: ConstructorParameters<typeof LocalDurableTestRunner>[0]['handlerFunction']) {}

  reset(): void {
    this.lambda.reset();
    this.sns.reset();
    this.published.length = 0;
    this.closed.clear();
    this.callbacksSent = 0;
    this.dropCallbacks = false;
    this.failPublishes = 0;
    this.publishAttempts = 0;
    this.execution = undefined;
    this.runner = new LocalDurableTestRunner<WorkflowResult>({ handlerFunction: this.handlerFunction });

    this.sns.on(PublishCommand).callsFake((input: { Subject?: string; Message?: string; MessageAttributes?: Record<string, { StringValue?: string }> }) => {
      this.publishAttempts += 1;
      if (this.failPublishes > 0) {
        this.failPublishes -= 1;
        throw new Error('SNS is having a bad minute');
      }
      this.published.push({ subject: input.Subject ?? '', message: input.Message ?? '', kind: input.MessageAttributes?.kind?.StringValue ?? '' });
      return { MessageId: `m-${this.published.length}` };
    });

    this.lambda.on(InvokeCommand).callsFake((input: { Payload?: Uint8Array; DurableExecutionName?: string }) => {
      const payload: unknown = JSON.parse(Buffer.from(input.Payload!).toString('utf8'));
      this.execution = this.runner.run({ payload });
      return { StatusCode: 202 };
    });

    this.lambda.on(SendDurableExecutionCallbackSuccessCommand).callsFake(async (input: { CallbackId: string; Result?: Uint8Array }) => {
      this.callbacksSent += 1;
      if (this.dropCallbacks || this.closed.has(input.CallbackId)) {
        throw new CallbackTimeoutException({ message: 'callback already closed', ...meta });
      }
      const op = this.runner.getOperation('manager-approval');
      if (op.getCallbackDetails()?.callbackId !== input.CallbackId) {
        throw new ResourceNotFoundException({ message: 'unknown callback', ...meta });
      }
      this.closed.add(input.CallbackId);
      await op.sendCallbackSuccess(Buffer.from(input.Result ?? new Uint8Array()).toString('utf8'));
      return {};
    });
  }

  /** Wait until the approver has been emailed, then return the token from that email. */
  async approverToken(): Promise<string> {
    await this.runner.getOperation('manager-approval').waitForData(WaitingOperationStatus.SUBMITTED);
    const email = this.published.find((p) => p.kind === 'approval-request');
    const token = /"token":"([^"]+)"/.exec(email?.message ?? '')?.[1];
    if (!token) throw new Error('no approval email with a token was sent');
    return token;
  }

  async result(): Promise<TestResult<WorkflowResult>> {
    if (!this.execution) throw new Error('no execution was started');
    return this.execution;
  }
}
