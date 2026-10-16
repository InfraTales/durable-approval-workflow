# Security

## Trust model

Anyone who can read the approval email can approve the request. The email is the credential. That suits an internal expense flow where the approver's mailbox is already trusted. If it isn't enough for you, put the decision endpoint behind your single sign-on and check the approver's identity before the claim.

Five things protect the decision:

- **One-time token.** The submitter step makes 32 random bytes per request. DynamoDB stores only the SHA-256 hash, so a leaked table export can't approve anything.
- **The callback ID stays inside AWS.** Approvers don't see it. With it, anyone holding `lambda:SendDurableExecutionCallbackSuccess` on the function could wake the workflow, so we keep it out of emails and logs.
- **A deadline.** The token works until the approval timeout and not after.
- **POST only.** Mail scanners fetch links with GET. The endpoint answers GET with 405, so a scanner can't approve.
- **The same answer for a wrong token and an unknown request.** Both get 404, so the endpoint doesn't confirm which request IDs exist.

## IAM

| Role | Permissions | Why |
|---|---|---|
| Workflow | `AWSLambdaBasicDurableExecutionRolePolicy`, DynamoDB `PutItem`, `UpdateItem`, `GetItem` on the table, `sns:Publish` on the approvals topic | CDK attaches the managed policy for `durableConfig`. It grants logging plus `lambda:CheckpointDurableExecution` and `lambda:GetDurableExecutionState` on `*` |
| Decide | `AWSLambdaBasicExecutionRole`, DynamoDB `UpdateItem` and `GetItem`, `lambda:SendDurableExecutionCallbackSuccess` on `workflow:*` | Callbacks are authorized against the durable execution's ARN. AWS docs say an unqualified function ARN never matches, so the resource ends in `:*` |
| Submit | `AWSLambdaBasicExecutionRole`, `lambda:InvokeFunction` on the `live` alias | Durable functions must be invoked with a version or alias |

We grant `GetItem` to Decide and Workflow in case IAM requires it for `ReturnValuesOnConditionCheckFailure`. We found no AWS page that says either way.

The managed policy's `Resource: "*"` is broader than AWS's own security guide suggests. To tighten it, replace it with an inline policy scoped to `function:<name>:*` and test the deploy.

## Endpoints

- **Submit** uses IAM auth. Your backend signs requests with SigV4. An unsigned call gets 403.
- **Decide** is public. It has no rate limit of its own. It rejects bodies over 4 KB, and every request costs one DynamoDB write at most. If abuse worries you, put AWS WAF in front through Amazon CloudFront, or set reserved concurrency on the function. Check your account's concurrency quota first, because reserved concurrency comes out of it.

## Data

- Durable execution state holds the request input and step results. Nothing secret goes in: no tokens, no callback IDs. To encrypt it with your own key, set `kmsKeyArn` in the function's durable configuration.
- Both SNS topics use the AWS managed key and refuse plain HTTP.
- The table has point-in-time recovery on, and the stack keeps it when you delete the stack.
