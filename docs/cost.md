# Cost

Prices are for us-east-1 from the AWS Price List API, checked on 2026-10-15. Check them again before you rely on them.

## What durable functions add to a normal Lambda bill

| Item | Price |
|---|---|
| Durable operations | $8.00 per million |
| Data written by those operations | $0.25 per GB |
| Data retained, while running and for the retention period after | $0.15 per GB-month |

There's no free tier for these three. Normal Lambda request and compute charges still apply, including the invocation that replays the workflow after a callback.

While the workflow waits for the approver, Lambda bills no compute time. The AWS pricing page says the function "does not incur duration charges until execution resumes" for on-demand functions. During the wait you pay for the retained data, which here is a few kilobytes.

## Operations per request

AWS's metering table counts each of these:

| Path | Operations |
|---|---|
| Needs approval (approved, rejected or expired) | 7: start 1, `record-request` 1, `waitForCallback` 3, `finalize` or `expire` 1, `announce-outcome` 1 |
| Auto-approved | 4: start 1, `record-request` 1, `auto-approve` 1, `announce-outcome` 1 |

Each step retry adds one operation. Completing a callback through the API adds none.

## 1,000 approval requests a month

Assumptions: every request needs a human, each handler invocation takes at most 1 second at 256 MB, and each execution writes under 4 KB. In the local runner, one approved execution produced a 3.8 KB history, with under 300 bytes of payloads.

| Item | Math | Monthly |
|---|---|---|
| Durable operations | 7,000 x $8.00 per million | $0.056 |
| Data written | 0.004 GB x $0.25 | $0.001 |
| Data retained | 0.004 GB x about 0.57 months (3-day wait plus 14-day retention) x $0.15 | under $0.001 |
| Lambda requests | 4,000 (workflow twice, submit, decide) x $0.20 per million | $0.0008 |
| Lambda compute, arm64 | 1,000 GB-seconds x $0.0000133334 | $0.013 |
| SNS email | 2,000 emails, first 1,000 free, then $2.00 per 100,000 | $0.02 |
| DynamoDB | 5 RCU and 5 WCU provisioned | $0 within the always-free 25 RCU and 25 WCU |

That's about $0.09 a month before the Lambda free tier, and about $0.08 with it (1 million requests and 400,000 GB-seconds a month cover the Lambda lines).

Not modeled: KMS requests for SNS encryption with the AWS managed key, DynamoDB point-in-time recovery storage, and CloudWatch Logs. At this size each is cents or less.

## What to watch

- The approval wait is free. Retries aren't. A step that fails five times costs five extra operations and five more invocations.
- AWS bills retention per GB-month. Raising it from 14 to 90 days multiplies the retained-data line by about five. That line is still tiny here.
- An execution that waits the full year still bills only retained data while it waits. This stack sets the execution timeout to the approval timeout plus one day, so nothing waits longer than that.
