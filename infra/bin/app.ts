#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ApprovalStack } from '../lib/approval-stack';

const app = new cdk.App();

// Optional: cdk deploy -c approverEmail=you@example.com -c alertEmail=ops@example.com
function emailContext(key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(value)) {
    throw new Error(`${key} must be an email address, got ${JSON.stringify(value)}`);
  }
  return value;
}

new ApprovalStack(app, 'DurableApprovalWorkflow', {
  approverEmail: emailContext('approverEmail'),
  alertEmail: emailContext('alertEmail'),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
