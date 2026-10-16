import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Decision, ExpenseRequest, Outcome, Status } from './domain';

/** One row per expense request. DynamoDB holds the decision; the callback only wakes the workflow. */
export interface ApprovalItem extends ExpenseRequest {
  status: Status;
  submittedAt: string;
  callbackId?: string;
  tokenHash?: string;
  expiresAt?: string;
  decision?: Decision;
  decidedAt?: string;
  finalizedAt?: string;
}

export type ClaimResult =
  | { kind: 'claimed'; callbackId: string }
  | { kind: 'already-final' } // the same decision is already recorded and closed
  | { kind: 'not-found' } // no such request, or the token is wrong (we don't say which)
  | { kind: 'conflict'; decision: Decision } // someone already recorded the other decision
  | { kind: 'closed' }; // expired or auto-approved: too late to decide

export class StoreConflictError extends Error {
  override readonly name = 'StoreConflictError';
}

export class ApprovalStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  /**
   * Insert the request once. A step can run twice (the write succeeds, then the checkpoint is lost),
   * so a second call with the same content returns the first submittedAt instead of failing.
   */
  async recordRequest(req: ExpenseRequest, now: string): Promise<{ submittedAt: string }> {
    const item: ApprovalItem = { ...req, status: 'PENDING', submittedAt: now };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(requestId)',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return { submittedAt: now };
    } catch (err) {
      const old = oldItem(err);
      if (!old) throw err;
      if (old.requester === req.requester && old.amountCents === req.amountCents && old.description === req.description) {
        return { submittedAt: old.submittedAt };
      }
      throw new StoreConflictError(`request ${req.requestId} already exists with different content`);
    }
  }

  /** Save where to send the decision. Runs inside the callback submitter, before anyone is told. */
  async attachCallback(requestId: string, callbackId: string, tokenHash: string, expiresAt: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { requestId },
        UpdateExpression: 'SET callbackId = :cb, tokenHash = :h, expiresAt = :exp',
        ConditionExpression: '#status = :pending AND attribute_not_exists(decision)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':cb': callbackId, ':h': tokenHash, ':exp': expiresAt, ':pending': 'PENDING' },
      }),
    );
  }

  /**
   * The approver's click. One conditional write decides who wins: the right token, still pending,
   * not past the deadline, and no other decision recorded. Repeating the same decision is allowed,
   * so a retry after a network error can deliver the callback again.
   */
  async claimDecision(requestId: string, tokenHash: string, decision: Decision, now: string): Promise<ClaimResult> {
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { requestId },
          UpdateExpression: 'SET decision = :d, decidedAt = if_not_exists(decidedAt, :now)',
          ConditionExpression:
            '#status = :pending AND tokenHash = :h AND expiresAt > :now AND (attribute_not_exists(decision) OR decision = :d)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':d': decision, ':h': tokenHash, ':now': now, ':pending': 'PENDING' },
          ReturnValues: 'ALL_NEW',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      const item = out.Attributes as ApprovalItem;
      if (!item.callbackId) throw new Error(`request ${requestId} has no callback ID`);
      return { kind: 'claimed', callbackId: item.callbackId };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const old = oldItem(err);
      if (!old || old.tokenHash !== tokenHash) return { kind: 'not-found' };
      if (old.status === decision) return { kind: 'already-final' };
      if (old.decision && old.decision !== decision) return { kind: 'conflict', decision: old.decision };
      return { kind: 'closed' };
    }
  }

  /** After the callback arrives: copy the claimed decision into status. Safe to run twice. */
  async finalizeFromClaim(requestId: string, now: string): Promise<Decision> {
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { requestId },
          UpdateExpression: 'SET #status = decision, finalizedAt = :now',
          ConditionExpression: '#status = :pending AND attribute_exists(decision)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':now': now, ':pending': 'PENDING' },
          ReturnValues: 'ALL_NEW',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return (out.Attributes as ApprovalItem).decision!;
    } catch (err) {
      const old = oldItem(err);
      if (old?.decision && old.status === old.decision) return old.decision; // a retry of this step
      throw err;
    }
  }

  /**
   * The callback timed out. Expire the request unless an approver claimed it first: a claim that
   * landed just before the deadline wins, even if its callback arrived too late to wake us.
   */
  async expire(requestId: string, now: string): Promise<Outcome> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { requestId },
          UpdateExpression: 'SET #status = :expired, finalizedAt = :now',
          ConditionExpression: '#status = :pending AND attribute_not_exists(decision)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': now, ':pending': 'PENDING' },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'EXPIRED';
    } catch (err) {
      const old = oldItem(err);
      if (!old) throw err;
      if (old.status === 'EXPIRED') return 'EXPIRED'; // a retry of this step
      if (old.decision) return this.finalizeFromClaim(requestId, now);
      throw err;
    }
  }

  async autoApprove(requestId: string, now: string): Promise<Outcome> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { requestId },
          UpdateExpression: 'SET #status = :auto, finalizedAt = :now',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':auto': 'AUTO_APPROVED', ':now': now, ':pending': 'PENDING' },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
    } catch (err) {
      if (oldItem(err)?.status !== 'AUTO_APPROVED') throw err;
    }
    return 'AUTO_APPROVED';
  }

  async get(requestId: string): Promise<ApprovalItem | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { requestId }, ConsistentRead: true }));
    return out.Item as ApprovalItem | undefined;
  }
}

/** The item as it was when a condition failed, from ReturnValuesOnConditionCheckFailure. */
function oldItem(err: unknown): ApprovalItem | undefined {
  if (!(err instanceof ConditionalCheckFailedException) || !err.Item) return undefined;
  return unmarshall(err.Item) as ApprovalItem;
}
