import { posix } from 'node:path';
import type { CodeInterpreter, ContentBlock } from '../sandbox/types';
import type { FileService } from '../storage/files';
import type { Principal } from '../auth';
import type { Config } from '../config';
import { ServiceError, invalid } from '../errors';
import { SandboxError } from '../sandbox/types';
import { isValidId } from '../storage/files';
import { RUN_ROOT } from './scripts';

/** A file reference as LibreChat sends it in an `/exec` `files` array. */
export interface InputFileRef {
  id: string;
  storage_session_id: string;
  name: string;
}

/** A generated file as LibreChat expects it back from `/exec`. */
export interface OutputFileRef {
  id: string;
  name: string;
  storage_session_id: string;
}

export interface PreparedInput {
  target: string;
  body: Buffer;
  readOnly: boolean;
}

export interface WriteEntry {
  path: string;
  text?: string;
  blob?: Buffer;
}

export interface ManifestFile {
  index: number;
  size: number;
  path: string;
}

export interface Manifest {
  exitCode?: number;
  setupFailed: boolean;
  streams: { stdout: number; stderr: number };
  files: ManifestFile[];
  skippedForSize: string[];
  truncatedFiles: number;
  deleted: string[];
}

export interface Collected {
  stdout: string;
  stderr: string;
  outputs: Array<{ path: string; body: Buffer }>;
  stdoutTruncated: boolean;
  skippedForTotal: string[];
}

export type Limits = Config['execution'];

export const runPath = (runId: string, name: string): string => `${RUN_ROOT}/${runId}/${name}`;

/**
 * Normalizes a LibreChat file name into a path relative to the data directory. Absolute paths
 * under the data directory are accepted; anything escaping it is rejected.
 */
export function sandboxPath(name: string, dataDir: string): string {
  const withoutDataDir = name.startsWith(`${dataDir}/`) ? name.slice(dataDir.length + 1) : name;
  const normalized = posix.normalize(withoutDataDir.replace(/^\/+/, ''));
  const segments = normalized.split('/');
  if (
    normalized === '' ||
    normalized === '.' ||
    segments.some((segment) => segment === '..' || segment === '') ||
    normalized.includes('\0') ||
    /[\n\r]/.test(normalized)
  ) {
    throw invalid('Invalid file name');
  }
  return normalized;
}

export function parseInputRefs(value: unknown, maxFiles: number): InputFileRef[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maxFiles) {
    throw invalid('files must be an array within the configured limit');
  }
  return value.map((entry) => {
    const ref = entry as Partial<InputFileRef>;
    if (
      !isValidId(ref?.id) ||
      !isValidId(ref?.storage_session_id) ||
      typeof ref?.name !== 'string'
    ) {
      throw invalid('Each file needs id, storage_session_id and name');
    }
    return { id: ref.id, storage_session_id: ref.storage_session_id, name: ref.name };
  });
}

/** Reads every referenced input from the caller's own namespace; a missing file fails the run. */
export async function loadInputs(
  principal: Principal,
  files: FileService,
  refs: InputFileRef[],
  limits: Limits,
): Promise<PreparedInput[]> {
  const targets = new Map<string, InputFileRef>();
  for (const ref of refs) {
    targets.set(sandboxPath(ref.name, limits.dataDir), ref);
  }
  let total = 0;
  const inputs = await Promise.all(
    [...targets].map(async ([target, ref]) => {
      const file = await files.read(principal, ref.storage_session_id, ref.id);
      if (file == null) {
        throw new ServiceError(
          404,
          'input_file_not_found',
          `Input file ${target} is not available`,
        );
      }
      total += file.body.length;
      return { target, body: file.body, readOnly: file.record.readOnly };
    }),
  );
  if (total > limits.maxInputBytes) {
    throw new ServiceError(
      413,
      'payload_too_large',
      'Input files exceed the configured size limit',
    );
  }
  return inputs;
}

/** Writes entries into the session in size-bounded batches. */
export async function stage(
  interpreter: CodeInterpreter,
  sessionId: string,
  entries: WriteEntry[],
  batchBytes: number,
): Promise<void> {
  const batches: WriteEntry[][] = [];
  let current: WriteEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const entrySize = entry.blob?.length ?? Buffer.byteLength(entry.text ?? '');
    if (current.length > 0 && size + entrySize > batchBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += entrySize;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  for (const batch of batches) {
    const result = await interpreter.invoke(sessionId, 'writeFiles', {
      content: batch.map(({ path, text, blob }) =>
        blob != null ? { path, blob: new Uint8Array(blob) } : { path, text: text ?? '' },
      ),
    });
    if (result.isError) {
      throw new SandboxError(
        'failed',
        `writeFiles failed: ${textOf(result.content).slice(0, 500)}`,
      );
    }
  }
}

export function textOf(content: ContentBlock[]): string {
  return content
    .map((block) => block.text ?? block.resource?.text ?? '')
    .filter(Boolean)
    .join('\n');
}

/** Runs a shell command synchronously and returns its stdout; non-zero exits are sandbox faults. */
export async function shell(
  interpreter: CodeInterpreter,
  sessionId: string,
  command: string,
): Promise<string> {
  const result = await interpreter.invoke(sessionId, 'executeCommand', { command });
  const exitCode = result.structured?.exitCode;
  if (result.isError || (exitCode != null && exitCode !== 0)) {
    throw new SandboxError(
      'failed',
      `command exited ${exitCode ?? 'with error'}: ${(result.structured?.stderr ?? textOf(result.content)).slice(0, 500)}`,
    );
  }
  return result.structured?.stdout ?? textOf(result.content);
}

const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

export function parseManifest(stdout: string): Manifest {
  const manifest: Manifest = {
    setupFailed: false,
    streams: { stdout: 0, stderr: 0 },
    files: [],
    skippedForSize: [],
    truncatedFiles: 0,
    deleted: [],
  };
  for (const line of stdout.split('\n')) {
    const [tag, ...rest] = line.trim().split(' ');
    if (tag === 'EXIT') {
      const code = Number(rest[0]);
      manifest.exitCode = Number.isInteger(code) ? code : undefined;
    } else if (tag === 'SETUP_FAILED') {
      manifest.setupFailed = true;
    } else if (tag === 'STREAM' && (rest[0] === 'stdout' || rest[0] === 'stderr')) {
      manifest.streams[rest[0]] = Number(rest[1]) || 0;
    } else if (tag === 'FILE' && rest.length === 3) {
      manifest.files.push({ index: Number(rest[0]), size: Number(rest[1]), path: decode(rest[2]) });
    } else if (tag === 'SKIP' && rest.length === 2) {
      manifest.skippedForSize.push(decode(rest[1]));
    } else if (tag === 'TRUNC' && rest[0] === 'max_files') {
      manifest.truncatedFiles = Number(rest[1]) || 0;
    } else if (tag === 'DEL' && rest.length === 1) {
      manifest.deleted.push(decode(rest[0]));
    }
  }
  return manifest;
}

function blockPath(block: ContentBlock): string | undefined {
  const uri = block.resource?.uri ?? block.uri ?? block.name;
  if (uri == null) {
    return undefined;
  }
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function blockBody(block: ContentBlock): Buffer | undefined {
  const blob = block.resource?.blob ?? block.data;
  if (blob != null) {
    return Buffer.from(blob);
  }
  const text = block.resource?.text ?? block.text;
  return text != null ? Buffer.from(text, 'utf8') : undefined;
}

/** Reads files back from the session; blocks are matched by path, falling back to request order. */
export async function readFiles(
  interpreter: CodeInterpreter,
  sessionId: string,
  paths: string[],
): Promise<Buffer[]> {
  if (paths.length === 0) {
    return [];
  }
  const result = await interpreter.invoke(sessionId, 'readFiles', { paths });
  if (result.isError) {
    throw new SandboxError('failed', `readFiles failed: ${textOf(result.content).slice(0, 500)}`);
  }
  const blocks = result.content.filter((block) => blockBody(block) != null);
  return paths.map((path, index) => {
    const block =
      blocks.find((candidate) => {
        const candidatePath = blockPath(candidate);
        return candidatePath === path || candidatePath?.endsWith(`/${path}`) === true;
      }) ?? (blocks.length === paths.length ? blocks[index] : undefined);
    const body = block != null ? blockBody(block) : undefined;
    if (body == null) {
      throw new SandboxError('failed', `readFiles returned no content for ${path}`);
    }
    return body;
  });
}

/** Reads captured streams and generated files named by a manifest, within the output budget. */
export async function collect(
  interpreter: CodeInterpreter,
  sessionId: string,
  runId: string,
  manifest: Manifest,
  limits: Limits,
): Promise<Collected> {
  const accepted: ManifestFile[] = [];
  const skippedForTotal: string[] = [];
  let total = 0;
  for (const file of manifest.files) {
    if (total + file.size > limits.maxOutputBytes) {
      skippedForTotal.push(file.path);
      continue;
    }
    total += file.size;
    accepted.push(file);
  }

  const [stdout, stderr] = await readFiles(interpreter, sessionId, [
    runPath(runId, 'stdout.cut'),
    runPath(runId, 'stderr.cut'),
  ]);
  const outputs: Collected['outputs'] = [];
  let batch: ManifestFile[] = [];
  let batchSize = 0;
  const flush = async (): Promise<void> => {
    const bodies = await readFiles(
      interpreter,
      sessionId,
      batch.map((file) => runPath(runId, `out/${file.index}`)),
    );
    bodies.forEach((body, index) => outputs.push({ path: batch[index].path, body }));
    batch = [];
    batchSize = 0;
  };
  for (const file of accepted) {
    if (batch.length > 0 && batchSize + file.size > limits.writeBatchBytes) {
      await flush();
    }
    batch.push(file);
    batchSize += file.size;
  }
  if (batch.length > 0) {
    await flush();
  }

  return {
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    outputs,
    stdoutTruncated: manifest.streams.stdout > limits.maxStdoutBytes,
    skippedForTotal,
  };
}

/** Stores generated files in a fresh session under the caller's namespace. */
export async function persistOutputs(
  principal: Principal,
  files: FileService,
  outputs: Collected['outputs'],
): Promise<{ sessionId: string; refs: OutputFileRef[] }> {
  const sessionId = files.newSessionId();
  const refs = await Promise.all(
    outputs.map(async ({ path, body }) => {
      const record = await files.put(principal, sessionId, {
        filename: path,
        body,
        scope: { kind: 'user', id: principal.userId },
      });
      return { id: record.fileId, name: path, storage_session_id: sessionId };
    }),
  );
  return { sessionId, refs };
}

export interface ArtifactTruncation {
  code: 'artifact_truncated';
  reasons: { max_files?: number; size?: number };
  skipped: string[];
  skipped_count: number;
}

export function truncationOf(
  manifest: Manifest,
  collected: Collected,
): ArtifactTruncation | undefined {
  const sizeSkipped = [...manifest.skippedForSize, ...collected.skippedForTotal];
  const count = sizeSkipped.length + manifest.truncatedFiles;
  if (count === 0) {
    return undefined;
  }
  return {
    code: 'artifact_truncated',
    reasons: {
      ...(manifest.truncatedFiles > 0 ? { max_files: manifest.truncatedFiles } : {}),
      ...(sizeSkipped.length > 0 ? { size: sizeSkipped.length } : {}),
    },
    skipped: sizeSkipped.slice(0, 20),
    skipped_count: count,
  };
}
