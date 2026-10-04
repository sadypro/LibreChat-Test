import { setTimeout as sleep } from 'node:timers/promises';
import type { ArtifactTruncation, OutputFileRef, PreparedInput } from './workspace';
import type { SessionPool, Lease } from '../sandbox/pool';
import type { Lang, RunState, TokenCodec } from './token';
import type { CodeInterpreter } from '../sandbox/types';
import type { FileService } from '../storage/files';
import type { Principal } from '../auth';
import type { Config } from '../config';
import type { Logger } from '../logger';
import {
  shell,
  stage,
  textOf,
  collect,
  runPath,
  loadInputs,
  truncationOf,
  parseManifest,
  persistOutputs,
  parseInputRefs,
} from './workspace';
import {
  quote,
  buildRunScript,
  buildPollScript,
  buildBashRunner,
  PYTHON_RUNNER,
  SETUP_FAILED_EXIT,
} from './scripts';
import { newRunId, inputEntries, collectOptions, resolveTimeoutMs } from './run';
import { SandboxError } from '../sandbox/types';
import { invalid } from '../errors';

export interface ToolDefinition {
  name: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultInput {
  call_id: string;
  result?: unknown;
  is_error?: boolean;
  error_message?: string;
}

export type ProgrammaticResponse =
  | { status: 'tool_call_required'; continuation_token: string; tool_calls: ToolCall[] }
  | {
      status: 'completed';
      session_id: string;
      stdout: string;
      stderr: string;
      files: OutputFileRef[];
      deleted_files?: string[];
      artifact_truncation?: ArtifactTruncation;
    }
  | { status: 'error'; error: string; stderr?: string };

export interface ProgrammaticRunner {
  handle(principal: Principal, body: unknown, requestId?: string): Promise<ProgrammaticResponse>;
  /** Stops the run a still-pending request belongs to; `false` when nothing matched. */
  cancel(principal: Principal, requestId: string): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface ProgrammaticOptions {
  interpreter: CodeInterpreter;
  pool: SessionPool;
  files: FileService;
  tokens: TokenCodec;
  execution: Config['execution'];
  config: Config['programmatic'];
  logger: Logger;
  now?: () => number;
}

const CALL_ID = /^c[0-9a-f]{32}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PYTHON_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(
    ' ',
  ),
);
const BASH_RESERVED = new Set(
  'if then else elif fi case esac for while until do done in function select time coproc declare typeset local readonly export unset'.split(
    ' ',
  ),
);

/** Mirrors `@librechat/agents` tool-name normalization so the model's calls resolve. */
export function toIdentifier(name: string, lang: Lang): string {
  let normalized = name
    .replace(lang === 'bash' ? /[-\s.]/g : /[-\s]/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
  if (/^[0-9]/.test(normalized)) {
    normalized = `_${normalized}`;
  }
  const reserved = lang === 'bash' ? BASH_RESERVED : PYTHON_KEYWORDS;
  return reserved.has(normalized) ? `${normalized}_tool` : normalized;
}

function toolMap(tools: unknown, lang: Lang): Record<string, string> {
  if (!Array.isArray(tools)) {
    throw invalid('tools must be an array');
  }
  const map: Record<string, string> = {};
  for (const tool of tools as ToolDefinition[]) {
    if (typeof tool?.name !== 'string' || tool.name === '') {
      throw invalid('Each tool needs a name');
    }
    const identifier = toIdentifier(tool.name, lang);
    if (!IDENTIFIER.test(identifier) || identifier.startsWith('_lc_')) {
      throw invalid(`Tool name ${tool.name} cannot be exposed to code`);
    }
    if (map[identifier] != null && map[identifier] !== tool.name) {
      throw invalid(`Tool names ${map[identifier]} and ${tool.name} collide`);
    }
    map[identifier] = tool.name;
  }
  return map;
}

function encodeResult(result: ToolResultInput | undefined): {
  json: string;
  value: string;
  ok: boolean;
} {
  if (result == null || result.is_error === true) {
    const message =
      result == null
        ? 'No result was provided for this tool call'
        : (result.error_message ?? 'Tool execution failed');
    return {
      json: JSON.stringify({ is_error: true, error_message: message }),
      value: message,
      ok: false,
    };
  }
  const value =
    typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? null);
  return {
    json: JSON.stringify({ is_error: false, result: result.result ?? null }),
    value,
    ok: true,
  };
}

function decodeInput(raw: string, lang: Lang): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return lang === 'bash' ? raw : {};
  }
}

interface ActiveRun {
  owner: string;
  sessionId: string;
  taskId?: string;
  lease?: Lease;
  cancelled: boolean;
  timer: NodeJS.Timeout;
}

/**
 * `/exec/programmatic`: code runs as a background task in a dedicated session; each tool call it
 * makes is written to an IPC directory, surfaced to LibreChat as `tool_call_required`, and
 * resumed when LibreChat posts the results back with the signed continuation token.
 */
export function createProgrammaticRunner(options: ProgrammaticOptions): ProgrammaticRunner {
  const { interpreter, pool, files, tokens, execution, config, logger, now = Date.now } = options;
  const runs = new Map<string, ActiveRun>();
  const requests = new Map<string, { owner: string; runId: string }>();

  const stopRun = async (runId: string, sessionId: string, taskId?: string): Promise<void> => {
    const active = runs.get(runId);
    if (active != null) {
      clearTimeout(active.timer);
      runs.delete(runId);
    }
    if (taskId != null) {
      await interpreter.invoke(sessionId, 'stopTask', { taskId }).catch(() => undefined);
    }
    if (active?.lease != null) {
      await active.lease.release('discard');
      return;
    }
    await interpreter.stopSession(sessionId).catch((error: Error) => {
      logger.warn('programmatic.session.stop_failed', { error: error.message });
    });
  };

  const track = (
    runId: string,
    run: Omit<ActiveRun, 'timer' | 'cancelled'>,
    expiresAt: number,
  ): void => {
    const timer = setTimeout(
      () => void stopRun(runId, run.sessionId, run.taskId),
      Math.max(0, expiresAt - now()),
    );
    timer.unref?.();
    runs.set(runId, { ...run, cancelled: false, timer });
  };

  const finish = async (
    principal: Principal,
    state: RunState,
    output: string,
  ): Promise<ProgrammaticResponse> => {
    const manifest = parseManifest(output);
    try {
      if (manifest.setupFailed || manifest.exitCode === SETUP_FAILED_EXIT) {
        return { status: 'error', error: 'Execution failed or timed out' };
      }
      const collected = await collect(
        interpreter,
        state.sessionId,
        state.runId,
        manifest,
        execution,
      );
      const { sessionId, refs } = await persistOutputs(principal, files, collected.outputs);
      const truncation = truncationOf(manifest, collected);
      return {
        status: 'completed',
        session_id: sessionId,
        stdout: collected.stdout,
        stderr: collected.stderr,
        files: refs,
        ...(manifest.deleted.length > 0 ? { deleted_files: manifest.deleted } : {}),
        ...(truncation != null ? { artifact_truncation: truncation } : {}),
      };
    } finally {
      await stopRun(state.runId, state.sessionId);
    }
  };

  const parseCalls = (output: string, lang: Lang): ToolCall[] =>
    output
      .split('\n')
      .map((line) => line.trim().split(' '))
      .filter(([tag, id]) => tag === 'CALL' && CALL_ID.test(id ?? ''))
      .map(([, id, name, input]) => ({
        id,
        name: Buffer.from(name ?? '', 'base64').toString('utf8'),
        input: decodeInput(Buffer.from(input ?? '', 'base64').toString('utf8'), lang),
      }));

  /** Polls until the run finishes, asks for tools, or exceeds this iteration's time budget. */
  const advance = async (
    principal: Principal,
    state: RunState,
    answered: string[],
  ): Promise<ProgrammaticResponse> => {
    const deadline = Math.min(now() + state.iterationTimeoutMs, state.expiresAt);
    const collectOpts = collectOptions(
      state.runId,
      state.inputs.map((target) => ({ target }) as PreparedInput),
      execution,
    );
    let release = answered;
    let seen = new Map<string, ToolCall>();
    while (true) {
      if (runs.get(state.runId)?.cancelled === true) {
        await stopRun(state.runId, state.sessionId, state.taskId);
        return { status: 'error', error: 'Execution failed or timed out' };
      }
      const output = await shell(
        interpreter,
        state.sessionId,
        buildPollScript({ runId: state.runId, answered: release, collect: collectOpts }),
      );
      release = [];
      if (/^EXIT /m.test(output)) {
        return finish(principal, state, output);
      }
      const calls = parseCalls(output, state.lang);
      const fresh = calls.filter((call) => !seen.has(call.id));
      calls.forEach((call) => seen.set(call.id, call));
      if (
        seen.size > 0 &&
        (fresh.length === 0 || config.batchWindowMs === 0 || now() >= deadline)
      ) {
        const toolCalls = [...seen.values()];
        seen = new Map();
        return {
          status: 'tool_call_required',
          continuation_token: tokens.sign({ ...state, pending: toolCalls.map((call) => call.id) }),
          tool_calls: toolCalls,
        };
      }
      if (now() >= deadline) {
        await stopRun(state.runId, state.sessionId, state.taskId);
        return { status: 'error', error: 'Time limit exceeded' };
      }
      await sleep(seen.size > 0 ? config.batchWindowMs : config.pollIntervalMs);
    }
  };

  const start = async (
    principal: Principal,
    body: Record<string, unknown>,
    bind: (runId: string) => void,
  ): Promise<ProgrammaticResponse> => {
    if (body.lang != null && body.lang !== 'py' && body.lang !== 'bash') {
      throw invalid('lang must be py or bash');
    }
    const lang: Lang = body.lang === 'bash' ? 'bash' : 'py';
    if (typeof body.code !== 'string' || body.code === '') {
      throw invalid('code is required');
    }
    const tools = toolMap(body.tools ?? [], lang);
    const iterationTimeoutMs = resolveTimeoutMs(
      typeof body.timeout === 'number' ? body.timeout : undefined,
      execution,
    );
    const inputs = await loadInputs(
      principal,
      files,
      parseInputRefs(body.files, execution.maxInputFiles),
      execution,
    );
    const runId = newRunId();
    bind(runId);
    const entries = inputEntries(runId, inputs);
    const runner = lang === 'py' ? 'runner.py' : 'runner.sh';
    const runScript = buildRunScript({
      runId,
      dataDir: execution.dataDir,
      inputs: entries.map((entry) => entry.staged),
      command: `${lang === 'py' ? 'python3' : 'bash'} "$R"/${quote(runner)}`,
      timeoutSeconds: config.maxDurationSeconds,
    });
    const lease = await pool.dedicated(principal.key, config.maxDurationSeconds + 60);
    const expiresAt = now() + config.maxDurationSeconds * 1000;
    let state: RunState | undefined;
    try {
      await stage(
        interpreter,
        lease.sessionId,
        [
          ...entries.map((entry) => entry.write),
          { path: runPath(runId, 'code'), text: body.code },
          { path: runPath(runId, 'tools.json'), text: JSON.stringify(tools) },
          {
            path: runPath(runId, runner),
            text: lang === 'py' ? PYTHON_RUNNER : buildBashRunner(tools),
          },
          { path: runPath(runId, 'run.sh'), text: runScript },
        ],
        execution.writeBatchBytes,
      );
      const started = await interpreter.invoke(lease.sessionId, 'startCommandExecution', {
        command: `bash ${runPath(runId, 'run.sh')}`,
      });
      if (started.isError) {
        throw new SandboxError(
          'failed',
          `startCommandExecution failed: ${textOf(started.content).slice(0, 500)}`,
        );
      }
      const taskId = started.structured?.taskId;
      state = {
        owner: principal.key,
        sessionId: lease.sessionId,
        runId,
        lang,
        taskId,
        inputs: inputs.map((input) => input.target),
        pending: [],
        expiresAt,
        iterationTimeoutMs,
      };
      track(runId, { owner: principal.key, sessionId: lease.sessionId, taskId, lease }, expiresAt);
      return await advance(principal, state, []);
    } catch (error) {
      if (state != null) {
        await stopRun(runId, state.sessionId, state.taskId);
      } else {
        await lease.release('discard');
      }
      throw error;
    }
  };

  const resume = async (
    principal: Principal,
    body: Record<string, unknown>,
    bind: (runId: string) => void,
  ): Promise<ProgrammaticResponse> => {
    const state = tokens.verify(body.continuation_token, principal.key, now());
    bind(state.runId);
    const results = Array.isArray(body.tool_results)
      ? (body.tool_results as ToolResultInput[])
      : [];
    const byId = new Map(
      results
        .filter((result) => typeof result?.call_id === 'string')
        .map((result) => [result.call_id, result]),
    );
    const writes = state.pending.flatMap((callId) => {
      const base = runPath(state.runId, `ipc/tmp/${callId}`);
      const { json, value, ok } = encodeResult(byId.get(callId));
      return [
        { path: `${base}/json`, text: json },
        { path: `${base}/value`, text: value },
        { path: `${base}/status`, text: ok ? 'ok' : 'error' },
      ];
    });
    try {
      await stage(interpreter, state.sessionId, writes, execution.writeBatchBytes);
      return await advance(principal, { ...state, pending: [] }, state.pending);
    } catch (error) {
      await stopRun(state.runId, state.sessionId, state.taskId);
      if (error instanceof SandboxError && error.failure === 'session_lost') {
        return { status: 'error', error: 'Execution failed or timed out' };
      }
      throw error;
    }
  };

  return {
    async handle(principal, rawBody, requestId) {
      const body = (rawBody ?? {}) as Record<string, unknown>;
      const bind = (runId: string): void => {
        if (requestId != null) {
          requests.set(requestId, { owner: principal.key, runId });
        }
      };
      try {
        return body.continuation_token != null
          ? await resume(principal, body, bind)
          : await start(principal, body, bind);
      } finally {
        if (requestId != null) {
          requests.delete(requestId);
        }
      }
    },
    async cancel(principal, requestId) {
      const request = requests.get(requestId);
      if (request == null || request.owner !== principal.key) {
        return false;
      }
      const run = runs.get(request.runId);
      if (run != null) {
        run.cancelled = true;
        if (run.taskId != null) {
          await interpreter
            .invoke(run.sessionId, 'stopTask', { taskId: run.taskId })
            .catch(() => undefined);
        }
      }
      return true;
    },
    async shutdown() {
      await Promise.all([...runs].map(([runId, run]) => stopRun(runId, run.sessionId, run.taskId)));
    },
  };
}
