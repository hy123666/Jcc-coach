const TRANSIENT_FILE_ERROR_CODES = new Set([
  "UNKNOWN",
  "EPERM",
  "EBUSY",
  "EACCES",
  "ENOTEMPTY",
]);

export function isTransientFileOperationError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  return TRANSIENT_FILE_ERROR_CODES.has(code)
    || /operation not permitted|resource busy|being used|access is denied|directory not empty|unknown error/i.test(message);
}

export async function retryTransientFileOperation(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 12);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 25);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 500);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientFileOperationError(error) || attempt === attempts - 1) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
