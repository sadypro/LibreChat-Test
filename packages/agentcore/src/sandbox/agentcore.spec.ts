import {
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
  StartCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { createAgentCoreInterpreter } from './agentcore';
import { SandboxError } from './types';

type Send = BedrockAgentCoreClient['send'];

function clientReturning(handler: (command: unknown) => unknown): { send: jest.Mock } {
  return { send: jest.fn(async (command: unknown) => handler(command)) };
}

async function* events(...items: object[]) {
  for (const item of items) {
    yield item;
  }
}

describe('createAgentCoreInterpreter', () => {
  it('starts and stops sessions against the configured code interpreter', async () => {
    const client = clientReturning((command) =>
      command instanceof StartCodeInterpreterSessionCommand ? { sessionId: 'sess-1' } : {},
    );
    const interpreter = createAgentCoreInterpreter({
      client: client as { send: Send },
      codeInterpreterId: 'ci-1',
    });
    await expect(interpreter.startSession({ name: 'n', timeoutSeconds: 600 })).resolves.toBe(
      'sess-1',
    );
    await interpreter.stopSession('sess-1');

    const [[start], [stop]] = client.send.mock.calls as [
      [StartCodeInterpreterSessionCommand],
      [StopCodeInterpreterSessionCommand],
    ];
    expect(start.input).toEqual({
      codeInterpreterIdentifier: 'ci-1',
      name: 'n',
      sessionTimeoutSeconds: 600,
    });
    expect(stop.input).toEqual({ codeInterpreterIdentifier: 'ci-1', sessionId: 'sess-1' });
  });

  it('merges streamed results into one tool result', async () => {
    const client = clientReturning(() => ({
      stream: events(
        { result: { content: [{ type: 'text', text: 'a' }] } },
        {
          result: {
            content: [{ type: 'text', text: 'b' }],
            structuredContent: { stdout: 'out', exitCode: 0 },
          },
        },
      ),
    }));
    const interpreter = createAgentCoreInterpreter({
      client: client as { send: Send },
      codeInterpreterId: 'ci-1',
    });
    const result = await interpreter.invoke('sess-1', 'executeCommand', { command: 'ls' });
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      structured: { stdout: 'out', exitCode: 0 },
      isError: false,
    });
    const [[invoke]] = client.send.mock.calls as [[InvokeCodeInterpreterCommand]];
    expect(invoke.input).toEqual({
      codeInterpreterIdentifier: 'ci-1',
      sessionId: 'sess-1',
      name: 'executeCommand',
      arguments: { command: 'ls' },
    });
  });

  it.each([
    [{ throttlingException: { message: 'slow down' } }, 'throttled'],
    [{ resourceNotFoundException: { message: 'gone' } }, 'session_lost'],
    [{ validationException: { message: 'bad', reason: 'CannotParse' } }, 'failed'],
  ])('classifies stream exception %o as %s', async (event, failure) => {
    const client = clientReturning(() => ({ stream: events(event) }));
    const interpreter = createAgentCoreInterpreter({
      client: client as { send: Send },
      codeInterpreterId: 'ci',
    });
    const error = await interpreter
      .invoke('s', 'readFiles', { paths: ['x'] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).failure).toBe(failure);
  });

  it('classifies thrown SDK errors and ignores stopping an already-gone session', async () => {
    const throttled = Object.assign(new Error('rate'), { name: 'ThrottlingException' });
    const gone = Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
    const interpreter = createAgentCoreInterpreter({
      client: {
        send: jest.fn().mockRejectedValueOnce(throttled).mockRejectedValueOnce(gone),
      } as unknown as { send: Send },
      codeInterpreterId: 'ci',
    });
    await expect(interpreter.startSession({ name: 'n', timeoutSeconds: 60 })).rejects.toMatchObject(
      {
        failure: 'throttled',
      },
    );
    await expect(interpreter.stopSession('s')).resolves.toBeUndefined();
  });
});
