# Contributing

Thanks for helping. Open an issue first for anything larger than a small fix.

## Setup

```bash
npm ci
docker run -d --name ddb-local-8018 -p 8018:8000 amazon/dynamodb-local:3.3.2
npm run check      # must pass before a PR
npm run test:int   # flow tests against DynamoDB Local on port 8018
```

Set `AWS_ENDPOINT_URL_DYNAMODB` to use DynamoDB Local on another port.

## Rules for the workflow code

- Anything that reads the clock, makes a random value, or calls AWS goes inside a step.
- Don't rename steps. Running executions replay against the old names.
- Every new DynamoDB condition needs a test in `test/flow/store.test.ts` that runs against DynamoDB Local.
- Break each new safeguard once on purpose and check that a test fails before you trust the test.

## Dependencies

We pin `@aws/durable-execution-sdk-js` and `@aws/durable-execution-sdk-js-testing` to exact versions. The testing package declares a peer range on the SDK, so Dependabot updates them together.

`@types/node` stays on major 24 to match the Lambda runtime.

## Pull requests

Describe what changed and why. CI runs the checks, the flow tests and `npm audit`. We squash-merge once CI is green.
