declare module '@openai/codex-sdk' {
  type CodexThreadOptions = {
    cwd?: string;
    workingDirectory?: string;
    model?: string;
    skipGitRepoCheck?: boolean;
    trustMode?: 'operator' | 'automated' | 'external' | string;
    canUseTool?: (input: unknown, context: unknown) => Promise<unknown> | unknown;
    threadId?: string;
    sessionId?: string;
    resume?: boolean;
  };

  type CodexRunResult = {
    finalResponse?: string;
    items?: unknown[];
    usage?: unknown;
  };

  type CodexStreamResult = {
    events: AsyncIterable<unknown>;
  };

  export class Codex {
    constructor(params?: { apiKey?: string });
    startThread(params?: CodexThreadOptions): {
      id?: string;
      run?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexRunResult | unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexStreamResult | unknown> | AsyncIterable<unknown>;
    };
    resumeThread?(
      threadId: string,
      params?: CodexThreadOptions,
    ): {
      id?: string;
      run?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexRunResult | unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexStreamResult | unknown> | AsyncIterable<unknown>;
    };
    getThread?(threadId: string): {
      id?: string;
      run?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexRunResult | unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexStreamResult | unknown> | AsyncIterable<unknown>;
    };
    supportedModels?: () => Promise<
      Array<{ value: string; displayName?: string; description?: string }>
    >;
  }
}

declare module '@openai/codex' {
  type CodexThreadOptions = {
    cwd?: string;
    workingDirectory?: string;
    model?: string;
    skipGitRepoCheck?: boolean;
    trustMode?: 'operator' | 'automated' | 'external' | string;
    canUseTool?: (input: unknown, context: unknown) => Promise<unknown> | unknown;
    threadId?: string;
    sessionId?: string;
    resume?: boolean;
  };

  type CodexRunResult = {
    finalResponse?: string;
    items?: unknown[];
    usage?: unknown;
  };

  type CodexStreamResult = {
    events: AsyncIterable<unknown>;
  };

  export class Codex {
    constructor(params?: { apiKey?: string });
    startThread(params?: CodexThreadOptions): {
      id?: string;
      run?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexRunResult | unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexStreamResult | unknown> | AsyncIterable<unknown>;
    };
    resumeThread?(
      threadId: string,
      params?: CodexThreadOptions,
    ): {
      id?: string;
      run?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexRunResult | unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexStreamResult | unknown> | AsyncIterable<unknown>;
    };
    getThread?(threadId: string): {
      id?: string;
      run?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexRunResult | unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<CodexStreamResult | unknown> | AsyncIterable<unknown>;
    };
    supportedModels?: () => Promise<
      Array<{ value: string; displayName?: string; description?: string }>
    >;
  }
}
