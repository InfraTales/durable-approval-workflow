import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { formatAmount, type ExpenseRequest, type Outcome } from './domain';

/** Sends messages through one Amazon SNS topic. Subscribe an email address to it to act as the approver. */
export class Notifier {
  constructor(
    private readonly topicArn: string,
    private readonly decisionUrl: string,
    private readonly sns: SNSClient = new SNSClient({}),
  ) {}

  /**
   * Tell the approver what to decide and how. The decision endpoint only accepts POST,
   * because email security scanners open links with GET and would approve by accident.
   */
  async requestApproval(req: ExpenseRequest, token: string, expiresAt: string): Promise<void> {
    const body = (decision: string) =>
      JSON.stringify({ requestId: req.requestId, token, decision });
    const message = [
      `${req.requester} asks for ${formatAmount(req.amountCents)}: ${req.description}`,
      `Request ID: ${req.requestId}`,
      `Decide before ${expiresAt}. After that the request expires.`,
      '',
      'To approve:',
      `curl -X POST ${this.decisionUrl} -H 'content-type: application/json' -d '${body('APPROVED')}'`,
      '',
      'To reject:',
      `curl -X POST ${this.decisionUrl} -H 'content-type: application/json' -d '${body('REJECTED')}'`,
    ].join('\n');
    await this.publish(`Approval needed: ${formatAmount(req.amountCents)} for ${req.requester}`, message, 'approval-request');
  }

  async announceOutcome(req: ExpenseRequest, outcome: Outcome): Promise<void> {
    await this.publish(
      `Expense ${req.requestId}: ${outcome}`,
      `${req.requester}'s request for ${formatAmount(req.amountCents)} (${req.description}) ended as ${outcome}.`,
      'outcome',
    );
  }

  private async publish(subject: string, message: string, kind: string): Promise<void> {
    await this.sns.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        // SNS rejects subjects over 100 characters or with anything but printable ASCII.
        Subject: subject.replace(/[^\x20-\x7e]/g, '?').slice(0, 100),
        Message: message,
        MessageAttributes: { kind: { DataType: 'String', StringValue: kind } },
      }),
    );
  }
}
