/* eslint-disable no-console */

import { redactLogArgs } from './redaction.js';

/**
 * Unified process output facade for CLI/runtime messaging.
 *
 * Keep direct console usage centralized here so call sites can migrate
 * without changing user-visible behavior.
 */
export const logger = {
  log: (...parts: unknown[]): void => {
    console.log(...redactLogArgs(parts));
  },
  info: (...parts: unknown[]): void => {
    console.info(...redactLogArgs(parts));
  },
  warn: (...parts: unknown[]): void => {
    console.warn(...redactLogArgs(parts));
  },
  error: (...parts: unknown[]): void => {
    console.error(...redactLogArgs(parts));
  },
};
