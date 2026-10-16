// Runs before each flow test file loads any module. The handler modules read these at import time.
import { randomUUID } from 'node:crypto';

process.env.AWS_ENDPOINT_URL_DYNAMODB ??= 'http://localhost:8018';
process.env.AWS_REGION = 'us-east-1';
// DynamoDB Local accepts any credentials. The key ID is AWS's documented placeholder.
process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'local-only-not-a-secret';
process.env.APPROVALS_TABLE = `approvals-${randomUUID()}`;
process.env.TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:approvals';
process.env.DECISION_URL = 'https://decide.example.com/';
process.env.AUTO_APPROVE_LIMIT_CENTS = '5000';
process.env.APPROVAL_TIMEOUT_SECONDS = '259200';
process.env.WORKFLOW_ALIAS_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:approval-workflow:live';
