import type { LambdaFunctionURLEvent } from 'aws-lambda';

/** A function URL event with only the fields our handlers read. */
export function urlEvent(method: string, body?: unknown, base64 = false): LambdaFunctionURLEvent {
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    isBase64Encoded: base64,
    body: base64 && text !== undefined ? Buffer.from(text).toString('base64') : text,
    requestContext: { http: { method } },
  } as unknown as LambdaFunctionURLEvent;
}
