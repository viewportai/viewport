/**
 * Structured logger — thin pino wrapper for the daemon.
 *
 * Usage:
 *   import { logger } from '../core/logger.js';
 *   const log = logger.child({ module: 'claude-adapter' });
 *   log.debug({ sessionId }, 'sendPrompt called');
 */

import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const logger = pino({
  level: isTest ? 'silent' : (process.env.VIEWPORT_LOG_LEVEL ?? 'debug'),
  transport: !isTest
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
});
