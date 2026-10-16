/** Read a required environment variable, or fail at cold start with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/** Read a required environment variable that must be a positive whole number. */
export function requirePositiveInt(name: string): number {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return value;
}
