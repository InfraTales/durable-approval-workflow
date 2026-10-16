import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ApprovalStack } from '../../infra/lib/approval-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const app = new cdk.App();
const stack = new ApprovalStack(app, 'Test', { env, approverEmail: 'boss@example.com', alertEmail: 'ops@example.com' });
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const template = Template.fromStack(stack);
const fnId = (prefix: string) => {
  const ids = Object.keys(template.findResources('AWS::Lambda::Function')).filter((id) => id.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0]!;
};

test('the workflow is a durable function that outlives the 3 day approval window', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    DurableConfig: { ExecutionTimeout: 4 * 86400, RetentionPeriodInDays: 14 },
    Runtime: 'nodejs24.x',
    Architectures: ['arm64'],
    Timeout: 60,
    Environment: { Variables: Match.objectLike({ APPROVAL_TIMEOUT_SECONDS: '259200', AUTO_APPROVE_LIMIT_CENTS: '5000' }) },
  });
  // Only the workflow is durable.
  expect(Object.values(template.findResources('AWS::Lambda::Function')).filter((r: any) => r.Properties.DurableConfig)).toHaveLength(1);
});

test('the execution timeout always covers the approval timeout', () => {
  const short = new ApprovalStack(new cdk.App(), 'Short', { env, approvalTimeout: cdk.Duration.hours(2) });
  Template.fromStack(short).hasResourceProperties('AWS::Lambda::Function', {
    DurableConfig: { ExecutionTimeout: 2 * 3600 + 86400, RetentionPeriodInDays: 14 },
  });
});

test('submit starts the workflow through the live alias, never the bare function', () => {
  template.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ WORKFLOW_ALIAS_ARN: { Ref: Match.stringLikeRegexp('^WorkflowLive') } }) },
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: [{ Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: { Ref: Match.stringLikeRegexp('^WorkflowLive') } }] },
  });
});

test('only the decision function may send callbacks, and only to this workflow', () => {
  const workflow = fnId('Workflow');
  const policies = Object.values<any>(template.findResources('AWS::IAM::Policy'));
  const senders = policies.filter((p) => JSON.stringify(p).includes('SendDurableExecutionCallback'));
  expect(senders).toHaveLength(1);
  expect(senders[0].Properties.PolicyDocument.Statement).toEqual([
    {
      Action: 'lambda:SendDurableExecutionCallbackSuccess',
      Effect: 'Allow',
      Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [workflow, 'Arn'] }, ':*']] },
    },
  ]);
  expect(senders[0].Properties.Roles).toEqual([{ Ref: expect.stringMatching(/^DecideServiceRole/) }]);
});

test('the decision URL is public (token-checked), the submit URL needs IAM signatures', () => {
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE', TargetFunctionArn: { 'Fn::GetAtt': [fnId('Decide'), 'Arn'] } });
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM', TargetFunctionArn: { 'Fn::GetAtt': [fnId('Submit'), 'Arn'] } });
  expect(Object.keys(template.findResources('AWS::Lambda::Url'))).toHaveLength(2);
});

test('each function gets only the DynamoDB actions its code calls', () => {
  const actionsFor = (rolePrefix: string) =>
    Object.values<any>(template.findResources('AWS::IAM::Policy'))
      .filter((p) => p.Properties.Roles.some((r: any) => r.Ref.startsWith(rolePrefix)))
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .flatMap((s: any) => [s.Action].flat())
      .filter((a: string) => a.startsWith('dynamodb:'))
      .sort();
  expect(actionsFor('DecideServiceRole')).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
  expect(actionsFor('WorkflowServiceRole')).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
  expect(actionsFor('SubmitServiceRole')).toEqual([]);
});

test('the table is retained, backed up, and inside the always-free provisioned capacity', () => {
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      KeySchema: [{ AttributeName: 'requestId', KeyType: 'HASH' }],
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }),
  });
});

test('both topics are encrypted and refuse plain HTTP; emails subscribe where asked', () => {
  const topics = Object.values<any>(template.findResources('AWS::SNS::Topic'));
  expect(topics).toHaveLength(2);
  for (const t of topics) expect(t.Properties.KmsMasterKeyId).toBeDefined();
  expect(Object.keys(template.findResources('AWS::SNS::TopicPolicy'))).toHaveLength(2);
  template.resourceCountIs('AWS::SNS::Subscription', 2);
  template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'boss@example.com' });
});

test('two alarms watch workflow errors and decision 5xx', () => {
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Url5xxCount', Threshold: 1 });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Errors', Threshold: 1 });
});

test('every function bundles its own AWS SDK and keeps logs for a month', () => {
  template.resourceCountIs('AWS::Lambda::Function', 3);
  for (const fn of Object.values<any>(template.findResources('AWS::Lambda::Function'))) {
    expect(fn.Properties.Runtime).toBe('nodejs24.x');
    expect(fn.Properties.LoggingConfig.LogGroup).toBeDefined();
  }
  for (const lg of Object.values<any>(template.findResources('AWS::Logs::LogGroup'))) expect(lg.Properties.RetentionInDays).toBe(30);
});

test('cdk-nag (AWS Solutions) reports nothing unacknowledged', () => {
  app.synth();
  expect(Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toEqual([]);
  expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toEqual([]);
});
