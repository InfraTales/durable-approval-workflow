/**
 * Checks a real deploy: `npm run smoke` after `npm run deploy`.
 * 1. An unsigned call to the submit URL is refused (403).
 * 2. A $20 request runs to AUTO_APPROVED.
 * 3. A $120 request is RUNNING and waiting on the approver, and a bad token gets 404.
 * The $120 execution stays open until you decide or it expires. That is the point.
 */
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { LambdaClient, ListDurableExecutionsByFunctionCommand } from '@aws-sdk/client-lambda';
import { SignatureV4 } from '@smithy/signature-v4';

const STACK = process.env.STACK_NAME ?? 'DurableApprovalWorkflow';
const region = process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

async function outputs(): Promise<Record<string, string>> {
  const out = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: STACK }));
  return Object.fromEntries((out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
}

async function signedPost(url: string, body: unknown): Promise<Response> {
  const u = new URL(url);
  const signer = new SignatureV4({ service: 'lambda', region, credentials: defaultProvider(), sha256: Sha256 });
  const text = JSON.stringify(body);
  const req = await signer.sign({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    headers: { host: u.hostname, 'content-type': 'application/json' },
    body: text,
  });
  return fetch(url, { method: 'POST', headers: req.headers, body: text });
}

async function statusOf(aliasArn: string, name: string): Promise<string | undefined> {
  const out = await new LambdaClient({ region }).send(
    new ListDurableExecutionsByFunctionCommand({ FunctionName: aliasArn, DurableExecutionName: name }),
  );
  return out.DurableExecutions?.[0]?.Status;
}

async function waitFor(aliasArn: string, name: string, want: string, deadlineMs = 60_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  let last: string | undefined;
  while (Date.now() < until) {
    last = await statusOf(aliasArn, name);
    if (last === want) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${name}: expected ${want}, last saw ${last ?? 'nothing'}`);
}

async function main(): Promise<void> {
  const o = await outputs();
  const run = Date.now().toString(36);

  const unsigned = await fetch(o.SubmitUrl!, { method: 'POST', body: '{}' });
  if (unsigned.status !== 403) throw new Error(`unsigned submit should be 403, got ${unsigned.status}`);
  console.log('ok  unsigned submit refused');

  const small = `smoke-small-${run}`;
  const res1 = await signedPost(o.SubmitUrl!, { requestId: small, requester: 'smoke@example.com', amountCents: 2000, description: 'Smoke test' });
  if (res1.status !== 202) throw new Error(`submit returned ${res1.status}: ${await res1.text()}`);
  await waitFor(o.WorkflowAliasArn!, small, 'SUCCEEDED');
  console.log('ok  $20 request auto-approved');

  const big = `smoke-big-${run}`;
  const res2 = await signedPost(o.SubmitUrl!, { requestId: big, requester: 'smoke@example.com', amountCents: 12000, description: 'Smoke test' });
  if (res2.status !== 202) throw new Error(`submit returned ${res2.status}: ${await res2.text()}`);
  await waitFor(o.WorkflowAliasArn!, big, 'RUNNING');
  const again = await signedPost(o.SubmitUrl!, { requestId: big, requester: 'smoke@example.com', amountCents: 12000, description: 'Smoke test' });
  console.log(`ok  $120 request is waiting for the approver; repeat submit answered ${again.status}`);

  const wrong = await fetch(o.DecisionUrl!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: big, token: 'x'.repeat(43), decision: 'APPROVED' }),
  });
  if (wrong.status !== 404) throw new Error(`wrong token should be 404, got ${wrong.status}`);
  console.log('ok  wrong token refused');
  console.log(`Check the approver inbox for request ${big}, then approve or reject it with the command in the email.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
