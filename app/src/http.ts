import type { LambdaFunctionURLEvent } from 'aws-lambda';

/** The structured response form a function URL accepts. */
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const MAX_BODY_BYTES = 4096;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(statusCode: number, body: unknown): HttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

/** Parse a small JSON body from a function URL event. Anything else is a 4xx, never a 500. */
export function readJsonBody(event: LambdaFunctionURLEvent): unknown {
  if (event.requestContext.http.method !== 'POST') throw new HttpError(405, 'use POST');
  const raw = event.body ?? '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}
