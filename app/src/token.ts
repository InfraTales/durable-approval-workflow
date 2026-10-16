import { createHash, randomBytes } from 'node:crypto';

/**
 * A one-time approval token: 32 random bytes, sent only to the approver.
 * Call this inside a durable step. Outside a step it returns a new value on every replay.
 */
export function newApprovalToken(): string {
  return randomBytes(32).toString('base64url');
}

/** We store only the SHA-256 of the token, so a leaked table export can't approve anything. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
