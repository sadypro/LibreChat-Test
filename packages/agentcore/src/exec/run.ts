import { randomBytes } from 'node:crypto';
import type { InputFileRef, OutputFileRef, ArtifactTruncation, PreparedInput } from './workspace';
import type { CodeInterpreter } from '../sandbox/types';
import type { FileService } from '../storage/files';
import type { SessionPool } from '../sandbox/pool';
import type { Principal } from '../auth';
import type { Config } from '../config';
import {
  shell,
  stage,
  collect,
  runPath,
  loadInputs,
  truncationOf,
  parseManifest,
  persistOutputs,
  parseInputRefs,
} from './workspace';
import { buildRunScript, buildCollectScript, quote, SETUP_FAILED_EXIT } from './scripts';
import { ServiceError, invalid } from '../errors';
import { SandboxError } from '../sandbox/types';

export interface ExecRequest {
  lang: string;
  code: string;
  args?: string[];
  files?: InputFileRef[];
  timeout?: number;
}

export interface ExecResponse {
  session_id: string;
  stdout: string;
  stderr: string;
  files: OutputFileRef[];
  deleted_files?: string[];
  artifact_truncation?: ArtifactTruncation;
  status?: string;
}

export interface Executor {
  execute(principal: Principal, request: ExecRequest): Promise<ExecResponse>;
}

export interface ExecutorOptions {
  interpreter: CodeInterpreter;
  pool: SessionPool;
  files: FileService;
  config: Config['execution'];
}

const TIMED_OUT_EXIT_CODES = new Set([124, 137]);

export const newRunId = (): string => `r${randomBytes(12).toString('hex')}`;

/** Validates the JSON body of `POST /exec` (unknown context fields LibreChat adds are ignored). */
export function parseExecRequest(body: unknown, limits: Config['execution']): ExecRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.lang !== 'string' || typeof input.code !== 'string' || input.code === '') {
    throw invalid('lang and code are required');
  }
  const args = input.args;
  if (args != null && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
    throw invalid('args must be an array of strings');
  }
  const timeout = input.timeout;
  if (
    timeout != null &&
    (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
  ) {
    throw invalid('timeout must be a positive number of milliseconds');
  }
  return {
    lang: input.lang,
    code: input.code,
    args: args as string[] | undefined,
    files: parseInputRefs(input.files, limits.maxInputFiles),
    timeout: timeout as number | undefined,
  };
}

export function resolveTimeoutMs(
  requested: number | undefined,
  limits: Config['execution'],
): number {
  return Math.min(Math.max(requested ?? limits.defaultTimeoutMs, 1000), limits.maxTimeoutMs);
}

export function timeoutNotice(exitCode: number | undefined, timeoutMs: number): string {
  return exitCode != null && TIMED_OUT_EXIT_CODES.has(exitCode)
    ? `\nExecution timed out after ${Math.round(timeoutMs / 1000)}s`
    : '';
}

export function inputEntries(runId: string, inputs: PreparedInput[]) {
  return inputs.map((input, index) => ({
    write: { path: runPath(runId, `in/${index}`), blob: input.body },
    staged: { staged: `in/${index}`, target: input.target, readOnly: input.readOnly },
  }));
}

export function collectOptions(
  runId: string,
  inputs: PreparedInput[],
  limits: Config['execution'],
) {
  return {
    runId,
    dataDir: limits.dataDir,
    inputTargets: inputs.map((input) => input.target),
    maxFiles: limits.maxOutputFiles,
    maxFileBytes: limits.maxOutputFileBytes,
    maxDepth: limits.maxOutputDepth,
    maxStdoutBytes: limits.maxStdoutBytes,
  };
}

/**
 * Stateless `/exec`: every run gets a cleared data directory in a session leased only to the
 * caller, inputs come from the caller's own storage, and generated files go back to it.
 */
export function createExecutor({ interpreter, pool, files, config }: ExecutorOptions): Executor {
  return {
    async execute(principal, request) {
      const language = config.languages[request.lang];
      if (language == null) {
        throw new ServiceError(
          400,
          'unsupported_capability',
          `Language ${request.lang} is not supported`,
        );
      }
      const timeoutMs = resolveTimeoutMs(request.timeout, config);
      const inputs = await loadInputs(principal, files, request.files ?? [], config);
      const runId = newRunId();
      const entries = inputEntries(runId, inputs);
      const scriptName = `main.${language.extension}`;
      const command = language.command
        .replace('{file}', `"$R"/${quote(scriptName)}`)
        .replace('{args}', (request.args ?? []).map(quote).join(' '));
      const runScript = buildRunScript({
        runId,
        dataDir: config.dataDir,
        inputs: entries.map((entry) => entry.staged),
        command,
        timeoutSeconds: timeoutMs / 1000,
      });
      const collectScript = buildCollectScript(collectOptions(runId, inputs, config));

      const attempt = async (): Promise<{
        lease: Awaited<ReturnType<SessionPool['acquire']>>;
        started: boolean;
        output?: string;
        error?: unknown;
      }> => {
        const lease = await pool.acquire(principal.key, timeoutMs);
        let started = false;
        try {
          await stage(
            interpreter,
            lease.sessionId,
            [
              ...entries.map((entry) => entry.write),
              { path: runPath(runId, scriptName), text: request.code },
              { path: runPath(runId, 'run.sh'), text: runScript },
              { path: runPath(runId, 'collect.sh'), text: collectScript },
            ],
            config.writeBatchBytes,
          );
          started = true;
          const output = await shell(
            interpreter,
            lease.sessionId,
            `bash ${runPath(runId, 'run.sh')}; bash ${runPath(runId, 'collect.sh')}`,
          );
          return { lease, started, output };
        } catch (error) {
          return { lease, started, error };
        }
      };

      let result = await attempt();
      if (
        result.error instanceof SandboxError &&
        result.error.failure === 'session_lost' &&
        !result.started
      ) {
        await result.lease.release('discard');
        result = await attempt();
      }
      const { lease } = result;
      if (result.error != null || result.output == null) {
        await lease.release('discard');
        throw result.error;
      }

      try {
        const manifest = parseManifest(result.output);
        if (manifest.setupFailed || manifest.exitCode === SETUP_FAILED_EXIT) {
          throw new ServiceError(
            500,
            'sandbox_setup_failed',
            'The sandbox data directory could not be prepared',
          );
        }
        const collected = await collect(interpreter, lease.sessionId, runId, manifest, config);
        await lease.release('reuse');
        const { sessionId, refs } = await persistOutputs(principal, files, collected.outputs);
        const truncation = truncationOf(manifest, collected);
        return {
          session_id: sessionId,
          stdout: collected.stdout,
          stderr: `${collected.stderr}${timeoutNotice(manifest.exitCode, timeoutMs)}`,
          files: refs,
          ...(manifest.deleted.length > 0 ? { deleted_files: manifest.deleted } : {}),
          ...(truncation != null ? { artifact_truncation: truncation } : {}),
          ...(collected.stdoutTruncated ? { status: 'OL' } : {}),
        };
      } catch (error) {
        await lease.release('discard');
        throw error;
      }
    },
  };
}
