import { DurableExecutionAlreadyStartedException, InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { parseExpenseRequest, ValidationError } from './domain';
import { HttpError, json, readJsonBody, type HttpResponse } from './http';

export interface SubmitDeps {
  lambda: Pick<LambdaClient, 'send'>;
  /** The workflow's alias ARN. Durable functions run a fixed version, never $LATEST by accident. */
  workflowArn: string;
}

/**
 * Starts one durable execution per request. The request ID is the execution name, so a client
 * that retries a timed-out submit gets the same execution back instead of a second approval.
 */
export function createSubmitHandler(deps: SubmitDeps) {
  return async (event: LambdaFunctionURLEvent): Promise<HttpResponse> => {
    try {
      const req = parseExpenseRequest(readJsonBody(event));
      await deps.lambda.send(
        new InvokeCommand({
          FunctionName: deps.workflowArn,
          InvocationType: 'Event', // return now; the workflow may run for days
          DurableExecutionName: req.requestId,
          Payload: Buffer.from(JSON.stringify(req)),
        }),
      );
      return json(202, { requestId: req.requestId });
    } catch (err) {
      if (err instanceof HttpError) return json(err.statusCode, { message: err.message });
      if (err instanceof ValidationError) return json(400, { message: err.message });
      if (err instanceof DurableExecutionAlreadyStartedException) {
        return json(409, { message: 'this requestId was already used for a different request' });
      }
      console.error('submit failed', err);
      return json(502, { message: 'could not start the workflow, try again with the same requestId' });
    }
  };
}
