import { LambdaClient } from '@aws-sdk/client-lambda';
import { requireEnv } from './config';
import { createSubmitHandler } from './submit';

export const handler = createSubmitHandler({
  lambda: new LambdaClient({}),
  workflowArn: requireEnv('WORKFLOW_ALIAS_ARN'),
});
