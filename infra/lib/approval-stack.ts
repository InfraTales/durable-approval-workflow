import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

export interface ApprovalStackProps extends cdk.StackProps {
  /** Receives approval requests and outcomes. Leave it out and subscribe later. */
  approverEmail?: string;
  /** Receives alarms. Optional. */
  alertEmail?: string;
  /** How long an approver has to decide. Default 3 days. */
  approvalTimeout?: cdk.Duration;
  /** Requests at or under this many cents skip the approver. Default $50.00. */
  autoApproveLimitCents?: number;
}

const SRC = path.join(__dirname, '..', '..', 'app', 'src');

/** Bundle everything, AWS SDK included, so the code runs on the exact versions we tested. */
const common: Partial<NodejsFunctionProps> = {
  runtime: lambda.Runtime.NODEJS_24_X,
  architecture: lambda.Architecture.ARM_64,
  memorySize: 256,
  bundling: { externalModules: [], minify: true, sourceMap: true, target: 'node24' },
  environment: { NODE_OPTIONS: '--enable-source-maps' },
};

export class ApprovalStack extends cdk.Stack {
  readonly workflow: NodejsFunction;
  readonly workflowAlias: lambda.Alias;

  constructor(scope: Construct, id: string, props: ApprovalStackProps = {}) {
    super(scope, id, props);
    const approvalTimeout = props.approvalTimeout ?? cdk.Duration.days(3);
    const autoApproveLimitCents = props.autoApproveLimitCents ?? 5000;
    // The whole execution must outlive the approval window, with room for retries and the last steps.
    const executionTimeout = cdk.Duration.seconds(approvalTimeout.toSeconds() + cdk.Duration.days(1).toSeconds());

    // Low, steady traffic: provisioned capacity inside DynamoDB's always-free 25 WCU / 25 RCU.
    const table = new dynamodb.Table(this, 'Approvals', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, // approval records are an audit trail
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const topic = new sns.Topic(this, 'ApprovalsTopic', {
      displayName: 'Expense approvals',
      masterKey: kms.Alias.fromAliasName(this, 'SnsKey', 'alias/aws/sns'),
      enforceSSL: true,
    });
    if (props.approverEmail) topic.addSubscription(new subs.EmailSubscription(props.approverEmail));

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

    // The approver's endpoint. Public on purpose: approvers prove themselves with the one-time token.
    const decide = new NodejsFunction(this, 'Decide', {
      ...common,
      entry: path.join(SRC, 'decide-handler.ts'),
      timeout: cdk.Duration.seconds(10),
      logGroup: logGroup('Decide'),
      environment: { ...common.environment, APPROVALS_TABLE: table.tableName },
    });
    const decideUrl = decide.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    // The claim is one conditional UpdateItem. GetItem is there in case IAM requires it for
    // ReturnValuesOnConditionCheckFailure; no AWS page we found says either way.
    table.grant(decide, 'dynamodb:UpdateItem', 'dynamodb:GetItem');

    // The durable workflow. Each invocation is short; the execution can last days.
    this.workflow = new NodejsFunction(this, 'Workflow', {
      ...common,
      entry: path.join(SRC, 'workflow-handler.ts'),
      timeout: cdk.Duration.seconds(60),
      logGroup: logGroup('Workflow'),
      durableConfig: { executionTimeout, retentionPeriod: cdk.Duration.days(14) },
      environment: {
        ...common.environment,
        APPROVALS_TABLE: table.tableName,
        TOPIC_ARN: topic.topicArn,
        DECISION_URL: decideUrl.url,
        AUTO_APPROVE_LIMIT_CENTS: String(autoApproveLimitCents),
        APPROVAL_TIMEOUT_SECONDS: String(approvalTimeout.toSeconds()),
      },
    });
    table.grant(this.workflow, 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'); // what ApprovalStore calls
    topic.grantPublish(this.workflow);

    // Durable functions must be invoked with a version or alias. Every replay runs on that version.
    this.workflowAlias = new lambda.Alias(this, 'WorkflowLive', { aliasName: 'live', version: this.workflow.currentVersion });

    // Callbacks are authorized on the function's qualified ARNs (function:name:*). This lives in its own
    // policy, not the role's default policy: the workflow already depends on the decision URL, so a
    // default-policy statement naming the workflow would make CloudFormation see a cycle.
    const sendCallback = new iam.Policy(this, 'DecideSendCallback', {
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:SendDurableExecutionCallbackSuccess'],
          resources: [`${this.workflow.functionArn}:*`],
        }),
      ],
    });
    decide.role!.attachInlinePolicy(sendCallback);
    cdk.Validations.of(sendCallback).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(this.workflow.node.defaultChild as lambda.CfnFunction)}.Arn>:*]`,
      reason: 'Durable execution callbacks are authorized on function:name:* (any version or alias of this one workflow function). It names one action and one function.',
    });

    // The submit endpoint, for your expense app's backend. IAM auth: callers sign with SigV4.
    const submit = new NodejsFunction(this, 'Submit', {
      ...common,
      entry: path.join(SRC, 'submit-handler.ts'),
      timeout: cdk.Duration.seconds(10),
      logGroup: logGroup('Submit'),
      environment: { ...common.environment, WORKFLOW_ALIAS_ARN: this.workflowAlias.functionArn },
    });
    const submitUrl = submit.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    this.workflowAlias.grantInvoke(submit);

    // Errors you want to hear about: a failed workflow invocation, or approvers getting 5xx.
    const alerts = new sns.Topic(this, 'Alerts', {
      masterKey: kms.Alias.fromAliasName(this, 'AlertsKey', 'alias/aws/sns'),
      enforceSSL: true,
    });
    if (props.alertEmail) alerts.addSubscription(new subs.EmailSubscription(props.alertEmail));
    const alarms = [
      this.workflow.metricErrors({ period: cdk.Duration.minutes(5) }).createAlarm(this, 'WorkflowErrors', {
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'The approval workflow threw. Check the durable execution history for the failed step.',
      }),
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Url5xxCount',
        dimensionsMap: { FunctionName: decide.functionName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }).createAlarm(this, 'DecideServerErrors', {
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Approvers are getting 5xx from the decision endpoint.',
      }),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(new actions.SnsAction(alerts));

    new cdk.CfnOutput(this, 'SubmitUrl', { value: submitUrl.url });
    new cdk.CfnOutput(this, 'DecisionUrl', { value: decideUrl.url });
    new cdk.CfnOutput(this, 'WorkflowAliasArn', { value: this.workflowAlias.functionArn });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });

    this.acknowledgeNagFindings([decide, this.workflow, submit]);
  }

  /** Every acknowledgement names the construct it covers and why. */
  private acknowledgeNagFindings(functions: NodejsFunction[]): void {
    for (const fn of functions) {
      const durable = fn === this.workflow;
      cdk.Validations.of(fn.role!).acknowledge({
        id: `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/${durable ? 'AWSLambdaBasicDurableExecutionRolePolicy' : 'AWSLambdaBasicExecutionRole'}]`,
        reason: durable
          ? 'CDK attaches this AWS managed policy for durableConfig. It adds lambda:CheckpointDurableExecution and lambda:GetDurableExecutionState, which the SDK needs to save and read its checkpoints.'
          : 'AWS managed policy that only lets the function write its own CloudWatch Logs.',
      });
    }
  }
}
