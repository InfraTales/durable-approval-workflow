import { CallbackTimeoutError, type DurableContext } from '@aws/durable-execution-sdk-js';
import { parseExpenseRequest, type Outcome } from './domain';
import type { Notifier } from './notifier';
import type { ApprovalStore } from './store';
import { hashToken, newApprovalToken } from './token';

export interface WorkflowSettings {
  /** Requests at or under this amount skip the human. */
  autoApproveLimitCents: number;
  /** How long the approver has. The workflow bills no compute while it waits. */
  approvalTimeoutSeconds: number;
}

export interface WorkflowDeps {
  store: Pick<ApprovalStore, 'recordRequest' | 'attachCallback' | 'finalizeFromClaim' | 'expire' | 'autoApprove'>;
  notifier: Pick<Notifier, 'requestApproval' | 'announceOutcome'>;
  settings: WorkflowSettings;
  clock?: () => Date;
}

export interface WorkflowResult {
  requestId: string;
  outcome: Outcome;
}

/**
 * The approval workflow. Lambda runs this function from the top on every invocation and
 * replays finished steps from the checkpoint log. So the rules are:
 * - code outside a step must give the same result every time (no clock, no random, no I/O);
 * - every side effect (DynamoDB, SNS, random tokens, the time) happens inside a step.
 */
export function createWorkflow(deps: WorkflowDeps) {
  const now = () => (deps.clock ?? (() => new Date()))().toISOString();
  const { store, notifier, settings } = deps;

  return async (event: unknown, ctx: DurableContext): Promise<WorkflowResult> => {
    // Pure validation: same input, same result, on every replay. A bad request fails the execution.
    const req = parseExpenseRequest(event);

    await ctx.step('record-request', () => store.recordRequest(req, now()));

    if (req.amountCents <= settings.autoApproveLimitCents) {
      const outcome = await ctx.step('auto-approve', () => store.autoApprove(req.requestId, now()));
      await ctx.step('announce-outcome', () => notifier.announceOutcome(req, outcome));
      return { requestId: req.requestId, outcome };
    }

    let outcome: Outcome;
    try {
      // The submitter runs as a step: it makes a token, stores where to send the decision, and emails
      // the approver. Then the function stops. Lambda bills no compute until the callback or the timeout.
      await ctx.waitForCallback(
        'manager-approval',
        async (callbackId) => {
          const token = newApprovalToken();
          const expiresAt = new Date(Date.parse(now()) + settings.approvalTimeoutSeconds * 1000).toISOString();
          await store.attachCallback(req.requestId, callbackId, hashToken(token), expiresAt);
          await notifier.requestApproval(req, token, expiresAt);
        },
        { timeout: { seconds: settings.approvalTimeoutSeconds } },
      );
      // The callback only wakes us up. The decision itself comes from DynamoDB.
      outcome = await ctx.step('finalize', () => store.finalizeFromClaim(req.requestId, now()));
    } catch (err) {
      if (!(err instanceof CallbackTimeoutError)) throw err;
      outcome = await ctx.step('expire', () => store.expire(req.requestId, now()));
    }

    await ctx.step('announce-outcome', () => notifier.announceOutcome(req, outcome));
    return { requestId: req.requestId, outcome };
  };
}
