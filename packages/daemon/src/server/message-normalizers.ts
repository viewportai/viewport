/**
 * Message normalizers — convert internal daemon types to wire-format update objects.
 *
 * These are pure functions that transform SessionMessage, Step, and PermissionRequest
 * into the Record<string, unknown> payloads sent inside session-update messages.
 */

import type { SessionMessage, Step, PermissionRequest } from '../core/types.js';

// ---------------------------------------------------------------------------
// SessionMessage → update object
// ---------------------------------------------------------------------------

export function messageToUpdate(msg: SessionMessage): Record<string, unknown> {
  switch (msg.type) {
    case 'agent_message':
      return {
        updateType: 'agent-message',
        messageId: msg.messageId,
        text: msg.text,
        timestamp: msg.timestamp,
      };
    case 'agent_message_chunk':
      return {
        updateType: 'agent-message-chunk',
        messageId: msg.messageId,
        text: msg.text,
        timestamp: msg.timestamp,
      };
    case 'agent_thought_chunk':
      return {
        updateType: 'agent-thought-chunk',
        messageId: msg.messageId,
        text: msg.text,
        timestamp: msg.timestamp,
      };
    case 'user_message':
      return {
        updateType: 'user-message',
        messageId: msg.messageId,
        text: msg.text,
        timestamp: msg.timestamp,
      };
    case 'tool_call':
      return {
        updateType: 'tool-call',
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        title: msg.title,
        input: msg.input,
        detail: msg.detail,
        status: msg.status,
        timestamp: msg.timestamp,
      };
    case 'tool_call_update':
      return {
        updateType: 'tool-call-update',
        toolCallId: msg.toolCallId,
        status: msg.status,
        title: msg.title,
        output: msg.output,
        timestamp: msg.timestamp,
      };
    case 'token_usage':
      return {
        updateType: 'token-usage',
        inputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
        costUsd: msg.totalCostUsd,
        timestamp: msg.timestamp,
      };
    case 'system_status':
      return {
        updateType: 'system-status',
        status: msg.status,
        timestamp: msg.timestamp,
      };
    default:
      return { updateType: 'unknown', timestamp: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// Step → update object
// ---------------------------------------------------------------------------

export function stepToUpdate(step: Step): Record<string, unknown> {
  return {
    updateType: 'step-committed',
    step: step.step,
    sha: step.sha,
    toolName: step.toolName,
    description: step.description,
    timestamp: step.timestamp,
  };
}

// ---------------------------------------------------------------------------
// PermissionRequest → update object
// ---------------------------------------------------------------------------

export function permissionToUpdate(request: PermissionRequest): Record<string, unknown> {
  return {
    updateType: 'permission-request',
    requestId: request.requestId,
    toolName: request.toolName,
    description: request.description,
    input: request.input,
    timestamp: Date.now(),
  };
}
