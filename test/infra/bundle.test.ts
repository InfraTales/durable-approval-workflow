import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync, type Metafile } from 'esbuild';

// The same esbuild settings NodejsFunction uses in the stack: one CommonJS file, nothing external.
const entries = ['workflow-handler', 'decide-handler', 'submit-handler'];
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));

beforeAll(() => {
  Object.assign(process.env, {
    APPROVALS_TABLE: 'approvals',
    TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:approvals',
    DECISION_URL: 'https://decide.example.com/',
    AUTO_APPROVE_LIMIT_CENTS: '5000',
    APPROVAL_TIMEOUT_SECONDS: '259200',
    WORKFLOW_ALIAS_ARN: 'arn:aws:lambda:us-east-1:123456789012:function:wf:live',
    AWS_REGION: 'us-east-1',
  });
});
afterAll(() => fs.rmSync(outdir, { recursive: true, force: true }));

test.each(entries)('%s bundles with no external imports and its handler loads', (name) => {
  const result = buildSync({
    entryPoints: [path.join(__dirname, '..', '..', 'app', 'src', `${name}.ts`)],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: path.join(outdir, name, 'index.js'),
    metafile: true,
    logLevel: 'silent',
  });
  const meta: Metafile = result.metafile;
  const output = Object.values(meta.outputs).find((o) => o.entryPoint);
  // Node built-ins may stay external. Everything else, the AWS SDK included, must be inside.
  const external = output!.imports.filter((i) => i.external && !i.path.startsWith('node:') && !isBuiltin(i.path));
  expect(external).toEqual([]);

  const mod = require(path.join(outdir, name, 'index.js')) as { handler?: unknown };
  expect(typeof mod.handler).toBe('function');
});

test('the durable SDK and its Lambda client end up in the workflow bundle', () => {
  const meta = buildSync({
    entryPoints: [path.join(__dirname, '..', '..', 'app', 'src', 'workflow-handler.ts')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    write: false,
    metafile: true,
    logLevel: 'silent',
  }).metafile;
  const inputs = Object.keys(meta.inputs);
  expect(inputs.some((i) => i.includes('@aws/durable-execution-sdk-js/'))).toBe(true);
  expect(inputs.some((i) => i.includes('@aws-sdk/client-lambda/'))).toBe(true);
});

function isBuiltin(p: string): boolean {
  return require('node:module').builtinModules.includes(p);
}
