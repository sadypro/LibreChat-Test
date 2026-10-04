import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, dirname, sep } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { CodeInterpreter, ToolResult, ToolName, ToolArguments } from '../../sandbox/types';
import { SandboxError } from '../../sandbox/types';

interface Task {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

interface LocalSession {
  dir: string;
  tasks: Map<string, Task>;
}

export interface LocalInterpreter extends CodeInterpreter {
  started: string[];
  stopped: string[];
  calls: Array<{ sessionId: string; name: ToolName }>;
  dirOf(sessionId: string): string;
  /** Makes the next `invoke` of `name` throw `error` before doing anything. */
  failNext(name: ToolName, error: Error): void;
  cleanup(): void;
}

/**
 * Runs the middleware's real scripts against a temp directory per session, standing in for the
 * AgentCore service at the `CodeInterpreter` boundary. Test-only: it executes code unsandboxed.
 */
export function createLocalInterpreter(): LocalInterpreter {
  const root = mkdtempSync(join(tmpdir(), 'lc-agentcore-'));
  const sessions = new Map<string, LocalSession>();
  const failures = new Map<ToolName, Error>();
  const started: string[] = [];
  const stopped: string[] = [];
  const calls: LocalInterpreter['calls'] = [];

  const sessionOf = (sessionId: string): LocalSession => {
    const session = sessions.get(sessionId);
    if (session == null) {
      throw new SandboxError('session_lost', `ResourceNotFoundException: ${sessionId}`);
    }
    return session;
  };

  const inside = (session: LocalSession, path: string): string => {
    const full = resolve(session.dir, path);
    if (!full.startsWith(session.dir + sep)) {
      throw new SandboxError('failed', `ValidationException: path escapes session: ${path}`);
    }
    return full;
  };

  const handlers: Partial<
    Record<ToolName, (session: LocalSession, args: ToolArguments) => ToolResult>
  > = {
    writeFiles(session, args) {
      for (const entry of args.content ?? []) {
        const full = inside(session, entry.path ?? '');
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, entry.blob != null ? Buffer.from(entry.blob) : (entry.text ?? ''));
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
    readFiles(session, args) {
      return {
        content: (args.paths ?? []).map((path) => {
          const full = inside(session, path);
          return {
            type: 'resource',
            resource: {
              type: 'blob',
              uri: `file://${full}`,
              blob: new Uint8Array(readFileSync(full)),
            },
          };
        }),
        isError: false,
      };
    },
    executeCommand(session, args) {
      const result = spawnSync('bash', ['-c', args.command ?? ''], {
        cwd: session.dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        content: [],
        structured: { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 },
        isError: false,
      };
    },
    startCommandExecution(session, args) {
      const taskId = `t${randomBytes(8).toString('hex')}`;
      const child = spawn('bash', ['-c', args.command ?? ''], { cwd: session.dir, detached: true });
      const task: Task = { child, stdout: '', stderr: '' };
      child.stdout?.on('data', (chunk: Buffer) => (task.stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (task.stderr += chunk.toString()));
      child.on('exit', (code) => (task.exitCode = code ?? 1));
      session.tasks.set(taskId, task);
      return { content: [], structured: { taskId, taskStatus: 'working' }, isError: false };
    },
    getTask(session, args) {
      const task = session.tasks.get(args.taskId ?? '');
      if (task == null) {
        return { content: [{ type: 'text', text: 'unknown task' }], isError: true };
      }
      return {
        content: [],
        structured: {
          taskId: args.taskId,
          taskStatus: task.exitCode == null ? 'working' : 'completed',
          stdout: task.stdout,
          stderr: task.stderr,
          exitCode: task.exitCode,
        },
        isError: false,
      };
    },
    stopTask(session, args) {
      const task = session.tasks.get(args.taskId ?? '');
      if (task?.child.pid != null && task.exitCode == null) {
        try {
          process.kill(-task.child.pid, 'SIGKILL');
        } catch {
          task.child.kill('SIGKILL');
        }
      }
      return {
        content: [],
        structured: { taskId: args.taskId, taskStatus: 'canceled' },
        isError: false,
      };
    },
  };

  const kill = (session: LocalSession): void => {
    for (const task of session.tasks.values()) {
      if (task.child.pid != null && task.exitCode == null) {
        try {
          process.kill(-task.child.pid, 'SIGKILL');
        } catch {
          task.child.kill('SIGKILL');
        }
      }
    }
  };

  return {
    started,
    stopped,
    calls,
    async startSession() {
      const sessionId = `local-${randomBytes(8).toString('hex')}`;
      const dir = join(root, sessionId);
      mkdirSync(dir);
      sessions.set(sessionId, { dir, tasks: new Map() });
      started.push(sessionId);
      return sessionId;
    },
    async stopSession(sessionId) {
      const session = sessions.get(sessionId);
      if (session == null) {
        return;
      }
      kill(session);
      sessions.delete(sessionId);
      stopped.push(sessionId);
      rmSync(session.dir, { recursive: true, force: true });
    },
    async invoke(sessionId, name, args) {
      calls.push({ sessionId, name });
      const failure = failures.get(name);
      if (failure != null) {
        failures.delete(name);
        throw failure;
      }
      const handler = handlers[name];
      if (handler == null) {
        throw new SandboxError('failed', `ValidationException: unsupported tool ${name}`);
      }
      return handler(sessionOf(sessionId), args);
    },
    dirOf: (sessionId) => sessionOf(sessionId).dir,
    failNext(name, error) {
      failures.set(name, error);
    },
    cleanup() {
      for (const session of sessions.values()) {
        kill(session);
      }
      sessions.clear();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
