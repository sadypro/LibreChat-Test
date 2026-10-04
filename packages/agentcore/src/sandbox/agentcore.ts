import {
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
  StartCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type {
  BedrockAgentCoreClient,
  CodeInterpreterStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import type { CodeInterpreter, ContentBlock, ToolResult } from './types';
import { SandboxError } from './types';

export interface AgentCoreOptions {
  client: Pick<BedrockAgentCoreClient, 'send'>;
  codeInterpreterId: string;
}

const THROTTLED = new Set(['ThrottlingException', 'ServiceQuotaExceededException']);
const SESSION_LOST = new Set(['ResourceNotFoundException', 'ConflictException']);

function classify(name: string | undefined, message: string | undefined): SandboxError {
  const detail = `${name ?? 'Error'}: ${message ?? 'no message'}`;
  if (name != null && THROTTLED.has(name)) {
    return new SandboxError('throttled', detail);
  }
  if (name != null && SESSION_LOST.has(name)) {
    return new SandboxError('session_lost', detail);
  }
  return new SandboxError('failed', detail);
}

function toSandboxError(error: unknown): SandboxError {
  if (error instanceof SandboxError) {
    return error;
  }
  const named = error as { name?: string; message?: string };
  return classify(named?.name, named?.message);
}

const STREAM_EXCEPTIONS = [
  ['accessDeniedException', 'AccessDeniedException'],
  ['conflictException', 'ConflictException'],
  ['internalServerException', 'InternalServerException'],
  ['resourceNotFoundException', 'ResourceNotFoundException'],
  ['serviceQuotaExceededException', 'ServiceQuotaExceededException'],
  ['throttlingException', 'ThrottlingException'],
  ['validationException', 'ValidationException'],
] as const;

function streamException(event: CodeInterpreterStreamOutput): SandboxError | undefined {
  for (const [member, name] of STREAM_EXCEPTIONS) {
    const exception = (event as Partial<Record<typeof member, { message?: string }>>)[member];
    if (exception != null) {
      return classify(name, exception.message);
    }
  }
  return undefined;
}

/** `CodeInterpreter` over the AgentCore data-plane API; results arrive as an event stream. */
export function createAgentCoreInterpreter({
  client,
  codeInterpreterId,
}: AgentCoreOptions): CodeInterpreter {
  return {
    async startSession({ name, timeoutSeconds }) {
      try {
        const output = await client.send(
          new StartCodeInterpreterSessionCommand({
            codeInterpreterIdentifier: codeInterpreterId,
            name,
            sessionTimeoutSeconds: timeoutSeconds,
          }),
        );
        if (output.sessionId == null) {
          throw new SandboxError('failed', 'StartCodeInterpreterSession returned no sessionId');
        }
        return output.sessionId;
      } catch (error) {
        throw toSandboxError(error);
      }
    },
    async stopSession(sessionId) {
      try {
        await client.send(
          new StopCodeInterpreterSessionCommand({
            codeInterpreterIdentifier: codeInterpreterId,
            sessionId,
          }),
        );
      } catch (error) {
        const sandboxError = toSandboxError(error);
        if (sandboxError.failure !== 'session_lost') {
          throw sandboxError;
        }
      }
    },
    async invoke(sessionId, name, args) {
      try {
        const output = await client.send(
          new InvokeCodeInterpreterCommand({
            codeInterpreterIdentifier: codeInterpreterId,
            sessionId,
            name,
            arguments: args,
          }),
        );
        const content: ContentBlock[] = [];
        let structured: ToolResult['structured'];
        let isError = false;
        for await (const event of output.stream ?? []) {
          const exception = streamException(event);
          if (exception != null) {
            throw exception;
          }
          if (event.result == null) {
            continue;
          }
          content.push(...(event.result.content ?? []));
          structured = event.result.structuredContent ?? structured;
          isError = isError || event.result.isError === true;
        }
        return { content, structured, isError };
      } catch (error) {
        throw toSandboxError(error);
      }
    },
  };
}
