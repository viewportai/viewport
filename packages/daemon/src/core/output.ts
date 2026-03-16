/* eslint-disable no-console */

/**
 * Unified process output facade for CLI/runtime messaging.
 *
 * Keep direct console usage centralized here so call sites can migrate
 * without changing user-visible behavior.
 */
export const logger = {
  log: (...parts: unknown[]): void => {
    console.log(...parts);
  },
  info: (...parts: unknown[]): void => {
    console.info(...parts);
  },
  warn: (...parts: unknown[]): void => {
    console.warn(...parts);
  },
  error: (...parts: unknown[]): void => {
    console.error(...parts);
  },
};
