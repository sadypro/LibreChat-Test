import type {
  ToolName,
  ContentBlock,
  ToolArguments,
  ToolResultStructuredContent,
} from '@aws-sdk/client-bedrock-agentcore';

export type { ToolName, ContentBlock, ToolArguments };

export interface ToolResult {
  content: ContentBlock[];
  structured?: ToolResultStructuredContent;
  isError: boolean;
}

export interface StartSessionInput {
  name: string;
  timeoutSeconds: number;
}

/**
 * The slice of AgentCore Code Interpreter the middleware drives. The production implementation
 * wraps `BedrockAgentCoreClient`; tests supply a local substitute at this boundary.
 */
export interface CodeInterpreter {
  startSession(input: StartSessionInput): Promise<string>;
  stopSession(sessionId: string): Promise<void>;
  invoke(sessionId: string, name: ToolName, args: ToolArguments): Promise<ToolResult>;
}

export type SandboxFailure = 'throttled' | 'session_lost' | 'failed';

/** Normalized AgentCore failure; `detail` is for server logs only and never reaches a client. */
export class SandboxError extends Error {
  readonly failure: SandboxFailure;
  readonly detail: string;

  constructor(failure: SandboxFailure, detail: string) {
    super(`Code interpreter ${failure.replace('_', ' ')}`);
    this.name = 'SandboxError';
    this.failure = failure;
    this.detail = detail;
  }
}
