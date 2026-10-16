/** One expense that someone wants paid back. Amounts are whole cents, so no float rounding. */
export interface ExpenseRequest {
  requestId: string;
  requester: string;
  amountCents: number;
  description: string;
}

export type Decision = 'APPROVED' | 'REJECTED';
export type Outcome = Decision | 'AUTO_APPROVED' | 'EXPIRED';
export type Status = 'PENDING' | Outcome;

export const DECISIONS: readonly Decision[] = ['APPROVED', 'REJECTED'];

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
}

// The request ID doubles as the durable execution name, so it uses only safe characters.
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_AMOUNT_CENTS = 10_000_000; // $100,000. Anything bigger is a typo or an attack.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(input: Record<string, unknown>, field: string, max: number): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ValidationError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

/** Validate untrusted input. Pure and deterministic, so it is safe to run on every replay. */
export function parseExpenseRequest(input: unknown): ExpenseRequest {
  if (!isRecord(input)) throw new ValidationError('request must be a JSON object');
  const requestId = input.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    throw new ValidationError('requestId must be 1 to 64 letters, digits, "-" or "_"');
  }
  const amountCents = input.amountCents;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    throw new ValidationError(`amountCents must be a whole number from 1 to ${MAX_AMOUNT_CENTS}`);
  }
  return {
    requestId,
    requester: text(input, 'requester', 200),
    amountCents,
    description: text(input, 'description', 500),
  };
}

export function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
}

export function formatAmount(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}
