# Runbook

## An approver says the link did nothing

1. Ask what status code they got. 404 means a wrong token or request ID. 409 means someone already recorded the other decision. 410 means the request expired.
2. Look up the request in the table. `status` and `decision` show what happened.
3. An approver who got two emails for one request should use the newer one. The approval email step retried (for example after an SNS error), and each attempt makes a new token. Only the last token works.
4. A 502 means DynamoDB saved the decision but the callback failed to send. The approver can run the same command again. The endpoint accepts a repeated decision and resends the callback.

## An execution is stuck in RUNNING

```bash
aws lambda list-durable-executions-by-function \
  --function-name <WorkflowAliasArn> --statuses RUNNING
```

A RUNNING execution waiting on `manager-approval` is normal until the deadline. If a request shows a `decision` in DynamoDB but the execution still waits, the callback was lost. The workflow fixes this itself at the deadline: the `expire` step finds the claim and records it. To finish sooner, resend the callback from the approver's command.

## A step keeps failing

The `WorkflowErrors` alarm fires when an invocation throws. Each step gets 6 attempts by default (1 plus 5 retries, up to 60 seconds apart). After that, the execution fails. Lambda doesn't retry a failed durable execution on its own.

Read the history to see which step failed and why:

```bash
aws lambda get-durable-execution-history --durable-execution-arn <arn>
```

## Changing the workflow without breaking running executions

Running executions replay on the version that started them, through the `live` alias. A deploy publishes a new version, and only new requests use it. Still:

- Don't rename a step or change the order of steps for code that may replay old checkpoints. The SDK fails a replay whose operation names don't match the log.
- Keep the DynamoDB item shape backward compatible. Old executions write to the same table.
- Adding `durableConfig` to an existing function replaces it. Don't set `functionName`, or the replacement fails.

## Deleting the stack

CloudFormation waits up to an hour for running durable executions to finish before it deletes the function. Stop them first:

```bash
aws lambda stop-durable-execution --durable-execution-arn <arn>
```

The stack keeps the table. Delete it by hand once you no longer need the records.
