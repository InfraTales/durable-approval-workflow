import { CallbackTimeoutException, LambdaClient, SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { isDecision } from './domain';
import { HttpError, json, readJsonBody, type HttpResponse } from './http';
import type { ApprovalStore } from './store';
import { hashToken } from './token';

export interface DecisionDeps {
  store: Pick<ApprovalStore, 'claimDecision'>;
  lambda: Pick<LambdaClient, 'send'>;
  clock?: () => Date;
}

/**
 * The approver's endpoint. It records the decision with one conditional write, then sends the
 * callback that wakes the workflow. The callback ID never leaves AWS: approvers only get a token.
 */
export function createDecisionHandler(deps: DecisionDeps) {
  const now = () => (deps.clock ?? (() => new Date()))().toISOString();

  return async (event: LambdaFunctionURLEvent): Promise<HttpResponse> => {
    try {
      const body = readJsonBody(event);
      if (typeof body !== 'object' || body === null) throw new HttpError(400, 'body must be a JSON object');
      const { requestId, token, decision } = body as Record<string, unknown>;
      if (typeof requestId !== 'string' || requestId.length > 64) throw new HttpError(400, 'requestId is required');
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new HttpError(400, 'token is required');
      if (!isDecision(decision)) throw new HttpError(400, 'decision must be APPROVED or REJECTED');

      const claim = await deps.store.claimDecision(requestId, hashToken(token), decision, now());
      switch (claim.kind) {
        case 'not-found':
          return json(404, { message: 'no pending request matches this ID and token' });
        case 'conflict':
          return json(409, { message: `this request was already ${claim.decision}` });
        case 'closed':
          return json(410, { message: 'this request is closed: it expired or was decided automatically' });
        case 'already-final':
        case 'already-claimed':
          return json(200, { requestId, decision });
        case 'claimed':
          await wakeWorkflow(deps.lambda, claim.callbackId, decision);
          return json(200, { requestId, decision });
      }
    } catch (err) {
      if (err instanceof HttpError) return json(err.statusCode, { message: err.message });
      console.error('decision failed', err);
      // The claim allows the same decision again, so the approver can retry safely.
      return json(502, { message: 'could not record the decision, try again' });
    }
  };
}

async function wakeWorkflow(lambda: Pick<LambdaClient, 'send'>, callbackId: string, decision: string): Promise<void> {
  try {
    await lambda.send(
      new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: callbackId,
        Result: Buffer.from(JSON.stringify({ decision })),
      }),
    );
  } catch (err) {
    // The callback already closed: a double click, or the deadline passed a moment ago.
    // Either way the claim is in DynamoDB and the workflow reads it from there.
    if (err instanceof CallbackTimeoutException) return;
    throw err;
  }
}
