export const CODEX_SDK_PACKAGE_CANDIDATES = ['@openai/codex-sdk', '@openai/codex'] as const;

export interface CodexSdkModule {
  Codex?: new (params?: { apiKey?: string; config?: Record<string, unknown> }) => {
    startThread: (params?: {
      cwd?: string;
      workingDirectory?: string;
      model?: string;
      threadId?: string;
      sessionId?: string;
      resume?: boolean;
    }) => {
      id?: string;
      run?: (input: unknown, turnOptions?: Record<string, unknown>) => Promise<unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<unknown> | AsyncIterable<unknown>;
    };
    resumeThread?: (
      threadId: string,
      params?: {
        cwd?: string;
        workingDirectory?: string;
        model?: string;
        threadId?: string;
        sessionId?: string;
        resume?: boolean;
      },
    ) => {
      id?: string;
      run?: (input: unknown, turnOptions?: Record<string, unknown>) => Promise<unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<unknown> | AsyncIterable<unknown>;
    };
    getThread?: (threadId: string) => {
      id?: string;
      run?: (input: unknown, turnOptions?: Record<string, unknown>) => Promise<unknown>;
      runStreamed?: (
        input: unknown,
        turnOptions?: Record<string, unknown>,
      ) => Promise<unknown> | AsyncIterable<unknown>;
    };
    supportedModels?: () => Promise<
      Array<{ value: string; displayName?: string; description?: string }>
    >;
  };
}

export async function importCodexSdkModule(): Promise<{
  module: CodexSdkModule;
  packageName: string;
} | null> {
  for (const packageName of CODEX_SDK_PACKAGE_CANDIDATES) {
    try {
      const mod = (await import(packageName)) as unknown as CodexSdkModule;
      if (mod?.Codex) {
        return { module: mod, packageName };
      }
    } catch {
      // Try next candidate package.
    }
  }
  return null;
}

export async function isCodexSdkAvailable(): Promise<boolean> {
  return (await importCodexSdkModule()) !== null;
}
