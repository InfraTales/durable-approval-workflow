# Durable approval workflow

An expense approval workflow built on AWS Lambda durable functions. A request comes in, an approver gets an email, and the workflow waits up to three days for a decision. While it waits, Lambda bills no compute time.

It's the companion code for an InfraTales article on AWS Builder Center. We built and tested it on a laptop against local engines. See [what we tested](#what-we-tested).

## How it works

Three Lambda functions share one Amazon DynamoDB table:

| Function | Endpoint | Job |
|---|---|---|
| `Submit` | Function URL, IAM auth | Checks the request and starts one durable execution, named after the request ID |
| `Workflow` | Invoked through the `live` alias | The durable function: records the request, emails the approver, waits, then records the outcome |
| `Decide` | Function URL, public, token-checked | Records the approver's decision with one conditional write, then sends the callback that wakes the workflow |

The workflow code is short enough to read in one sitting: [`app/src/workflow.ts`](app/src/workflow.ts). The steps are:

1. `record-request` writes the request to DynamoDB.
2. Requests of $50.00 or less go straight to `auto-approve`.
3. `manager-approval` is a `waitForCallback`. Its submitter makes a one-time token, stores the callback ID and a hash of the token, and emails the approver through Amazon SNS. Then the function stops.
4. On the callback, `finalize` copies the decision from DynamoDB into the request's status. On timeout, `expire` marks the request expired, unless an approver claimed it first.
5. `announce-outcome` sends the result.

The callback ID stays inside AWS. Approvers get a token, and the `Decide` function looks up the callback ID itself.

## Design choices

**DynamoDB holds the decision, and the callback only wakes the workflow.** A decision is valid when one conditional update succeeds: right token, still pending, before the deadline, no other decision recorded. That one write settles double clicks, approve-and-reject races and a click that lands as the deadline passes. The tests run all of these against DynamoDB Local.

**Side effects live inside steps.** Lambda reruns the handler from the top on every invocation and replays finished steps from the checkpoint log. Code outside steps must give the same answer every time, so the clock, random tokens, DynamoDB and SNS calls all run inside steps.

**The decision endpoint only accepts POST.** Email security scanners open links with GET. An approve link would approve on its own, so the email carries a `curl` command instead.

**One execution per request.** `Submit` passes the request ID as the durable execution name. A client that retries gets the same execution back. The same ID with a different payload gets a 409.

## Run it

You need Node.js 24 and Docker.

```bash
npm ci
npm run check            # type check, lint, unit/infra/bundle tests, cdk synth with cdk-nag
docker run -d --name ddb-local-8018 -p 8018:8000 amazon/dynamodb-local:3.3.2
npm run test:int         # flow tests: real handlers + local durable runner + DynamoDB Local
```

To deploy, use a CDK-bootstrapped account in a Region that has durable functions:

```bash
npx cdk deploy -c approverEmail=you@example.com -c alertEmail=you@example.com
npm run smoke
```

Confirm the SNS subscription email before you run the smoke test. The smoke test checks that an unsigned submit gets 403, a $20 request is auto-approved, and a $120 request stays `RUNNING` while it waits for you.

## What we tested

| Layer | What runs |
|---|---|
| Unit | Input validation, handlers with mocked AWS clients, notifier, config |
| Flow | The three handler modules as Lambda loads them, the official `LocalDurableTestRunner`, and DynamoDB Local. Approve, reject, timeout, duplicate callback, a claim racing the deadline, replay with a retried step, and the SDK's non-determinism check |
| Store | Every condition expression against DynamoDB Local, including concurrent approve/reject and claim/expire races |
| Infra | CDK template assertions and cdk-nag (AWS Solutions) |
| Bundle | Each handler bundles with esbuild with nothing external and loads |

Not verified: we haven't deployed this stack to an AWS account yet. CloudFormation synth and cdk-nag pass. `npm run smoke` is the check for a real account.

## Docs

- [docs/cost.md](docs/cost.md): what a request costs, and what you pay while it waits
- [docs/security.md](docs/security.md): the trust model and the IAM choices
- [docs/runbook.md](docs/runbook.md): stuck executions, failed steps, how to change the workflow without breaking running executions

## License

You can use the code under MIT-0, as [LICENSE](LICENSE) describes.
