import { LambdaClient } from '@aws-sdk/client-lambda';
import { requireEnv } from './config';
import { createDecisionHandler } from './decide';
import { ApprovalStore } from './store';

export const handler = createDecisionHandler({
  store: new ApprovalStore(requireEnv('APPROVALS_TABLE')),
  lambda: new LambdaClient({}),
});
