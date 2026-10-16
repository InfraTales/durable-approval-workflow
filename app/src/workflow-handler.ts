import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { requireEnv, requirePositiveInt } from './config';
import { Notifier } from './notifier';
import { ApprovalStore } from './store';
import { createWorkflow } from './workflow';

// Read at cold start. A durable execution always replays on the version that started it,
// so these values can't change under a running workflow.
const workflow = createWorkflow({
  store: new ApprovalStore(requireEnv('APPROVALS_TABLE')),
  notifier: new Notifier(requireEnv('TOPIC_ARN'), requireEnv('DECISION_URL')),
  settings: {
    autoApproveLimitCents: requirePositiveInt('AUTO_APPROVE_LIMIT_CENTS'),
    approvalTimeoutSeconds: requirePositiveInt('APPROVAL_TIMEOUT_SECONDS'),
  },
});

export const handler = withDurableExecution(workflow);
