// Flow tests: the real handler modules, the official local durable test runner,
// and DynamoDB Local. Start it first (see CONTRIBUTING.md) or set AWS_ENDPOINT_URL_DYNAMODB.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/flow'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/test/support/flow-env.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 60000,
};
