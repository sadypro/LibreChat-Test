import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import type { FileRecord, FileScope, FileService } from '../storage/files';
import type { ProgrammaticRunner } from '../exec/programmatic';
import type { Authenticator, Principal } from '../auth';
import type { Executor } from '../exec/run';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { ServiceError, invalid, notFound } from '../errors';
import { isValidId, matchesScope } from '../storage/files';
import { SandboxError } from '../sandbox/types';
import { sandboxPath } from '../exec/workspace';
import { parseExecRequest } from '../exec/run';
import { parseMultipart } from './multipart';

export interface AppDependencies {
  config: Config;
  authenticate: Authenticator;
  executor: Executor;
  programmatic: ProgrammaticRunner;
  files: FileService;
  logger: Logger;
}

const REQUEST_ID_HEADER = 'x-librechat-code-request-id';

const principalOf = (res: Response): Principal => res.locals.principal as Principal;

function single(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Parses `kind`/`id`/`version` from a form or query; `required` demands a complete scope. */
function parseScope(source: Record<string, unknown>, required: boolean): Partial<FileScope> {
  const kind = single(source.kind);
  const id = single(source.id);
  const rawVersion = single(source.version);
  if (kind != null && kind !== 'user' && kind !== 'agent' && kind !== 'skill') {
    throw invalid('kind must be user, agent or skill');
  }
  const version = rawVersion != null ? Number(rawVersion) : undefined;
  if (version != null && !Number.isInteger(version)) {
    throw invalid('version must be an integer');
  }
  if (required) {
    if (kind == null || id == null) {
      throw invalid('kind and id are required');
    }
    if ((kind === 'skill') !== (version != null)) {
      throw invalid('version is required for skill files and only for them');
    }
  }
  return { kind: kind as FileScope['kind'] | undefined, id, version };
}

/** A user-kind file may only be stored or fetched by that user. */
function assertOwnScope(principal: Principal, scope: Partial<FileScope>): void {
  if (scope.kind === 'user' && scope.id != null && scope.id !== principal.userId) {
    throw new ServiceError(403, 'forbidden', 'Files of another user are not accessible');
  }
}

function contentDisposition(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

function describe(record: FileRecord) {
  return {
    fileId: record.fileId,
    filename: record.filename,
    id: record.fileId,
    name: record.filename,
    storage_session_id: record.sessionId,
    size: record.size,
    lastModified: record.lastModified.toISOString(),
    metadata: { 'original-filename': record.filename },
  };
}

function sendError(error: unknown, res: Response, logger: Logger): void {
  if (error instanceof ServiceError) {
    if (error.retryAfterSeconds != null) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }
    res.status(error.status).json({
      error: error.code,
      message: error.message,
      ...(error.retryAfterSeconds != null ? { retry_after_seconds: error.retryAfterSeconds } : {}),
    });
    return;
  }
  if (error instanceof SandboxError) {
    logger.warn('sandbox.error', { failure: error.failure, detail: error.detail });
    if (error.failure === 'throttled') {
      res.setHeader('Retry-After', '2');
      res.status(429).json({
        error: 'rate_limited',
        message: 'Code interpreter is busy',
        retry_after_seconds: 2,
      });
      return;
    }
    res
      .status(502)
      .json({ error: 'sandbox_unavailable', message: 'Code interpreter is unavailable' });
    return;
  }
  const typed = error as { type?: string; status?: number };
  if (typed?.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large' });
    return;
  }
  if (typed?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_request', message: 'Malformed JSON body' });
    return;
  }
  logger.error('request.failed', { error: (error as Error)?.message ?? 'unknown' });
  res.status(500).json({ error: 'internal_error', message: 'Internal error' });
}

function routes({ config, executor, programmatic, files }: AppDependencies): Router {
  const router = express.Router();
  router.use(express.json({ limit: config.server.jsonBodyLimitBytes }));
  for (const name of ['sessionId', 'fileId']) {
    router.param(name, (_req, _res, next, value: string) => {
      next(isValidId(value) ? undefined : notFound('Not found'));
    });
  }

  router.post('/exec', async (req, res) => {
    res.json(
      await executor.execute(principalOf(res), parseExecRequest(req.body, config.execution)),
    );
  });

  router.post('/exec/programmatic', async (req, res) => {
    const requestId = single(req.get(REQUEST_ID_HEADER));
    res.json(await programmatic.handle(principalOf(res), req.body, requestId));
  });

  router.post('/exec/programmatic/cancel', async (req, res) => {
    const requestId = single((req.body as { request_id?: unknown })?.request_id);
    if (requestId == null) {
      throw invalid('request_id is required');
    }
    if (!(await programmatic.cancel(principalOf(res), requestId))) {
      throw notFound('No running request with that id');
    }
    res.json({ status: 'cancelled' });
  });

  router.post('/upload', async (req, res) => {
    const principal = principalOf(res);
    const form = await parseMultipart(req, config.uploads.maxFileBytes, 1);
    const scope = parseScope(form.fields, true) as FileScope;
    assertOwnScope(principal, scope);
    const [file] = form.files;
    if (file == null) {
      throw invalid('No file provided');
    }
    const sessionId = files.sessionFor(principal, scope);
    const record = await files.put(principal, sessionId, {
      filename: sandboxPath(file.filename, config.execution.dataDir),
      body: file.body,
      scope,
    });
    res.json({
      message: 'success',
      storage_session_id: sessionId,
      files: [{ fileId: record.fileId, filename: record.filename }],
    });
  });

  router.post('/upload/batch', async (req, res) => {
    const principal = principalOf(res);
    const form = await parseMultipart(
      req,
      config.uploads.maxFileBytes,
      config.uploads.maxBatchFiles,
    );
    const scope = parseScope(form.fields, true) as FileScope;
    assertOwnScope(principal, scope);
    if (form.files.length === 0) {
      throw invalid('No files provided');
    }
    const sessionId = files.sessionFor(principal, scope);
    const readOnly = form.fields.read_only === 'true';
    const results = await Promise.all(
      form.files.map(async (file) => {
        try {
          const record = await files.put(principal, sessionId, {
            filename: sandboxPath(file.filename, config.execution.dataDir),
            body: file.body,
            scope,
            readOnly,
          });
          return { status: 'success' as const, fileId: record.fileId, filename: record.filename };
        } catch (error) {
          const message = error instanceof ServiceError ? error.message : 'Upload failed';
          return { status: 'error' as const, filename: file.filename, error: message };
        }
      }),
    );
    const succeeded = results.filter((result) => result.status === 'success').length;
    res.json({
      message: succeeded === 0 ? 'error' : 'success',
      storage_session_id: sessionId,
      files: results,
      succeeded,
      failed: results.length - succeeded,
    });
  });

  router.get('/download/:sessionId/:fileId', async (req, res) => {
    const principal = principalOf(res);
    const scope = parseScope(req.query, false);
    assertOwnScope(principal, scope);
    const opened = await files.open(principal, req.params.sessionId, req.params.fileId);
    if (opened == null || !matchesScope(opened.record, scope)) {
      opened?.body.destroy();
      throw notFound('File not found');
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(opened.record.size));
    res.setHeader('Content-Disposition', contentDisposition(opened.record.filename));
    res.setHeader('X-Original-Filename', encodeURIComponent(opened.record.filename));
    opened.body.on('error', () => res.destroy());
    opened.body.pipe(res);
  });

  router.get('/files/:sessionId', async (req, res) => {
    const principal = principalOf(res);
    const scope = parseScope(req.query, false);
    assertOwnScope(principal, scope);
    const records = (await files.list(principal, req.params.sessionId)).filter((record) =>
      matchesScope(record, scope),
    );
    if (records.length === 0) {
      throw notFound('Session not found');
    }
    res.json(records.map(describe));
  });

  router.delete('/files/:sessionId/:fileId', async (req, res) => {
    const principal = principalOf(res);
    const scope = parseScope(req.query, false);
    assertOwnScope(principal, scope);
    const record = await files.info(principal, req.params.sessionId, req.params.fileId);
    if (record == null || !matchesScope(record, scope)) {
      throw notFound('File not found');
    }
    await files.remove(principal, req.params.sessionId, req.params.fileId);
    res.json({ message: 'success' });
  });

  router.get('/sessions/:sessionId/objects/:fileId', async (req, res) => {
    const principal = principalOf(res);
    const scope = parseScope(req.query, false);
    assertOwnScope(principal, scope);
    const record = await files.info(principal, req.params.sessionId, req.params.fileId);
    if (record == null || !matchesScope(record, scope)) {
      throw notFound('File not found');
    }
    res.json({
      lastModified: record.lastModified.toISOString(),
      originalFilename: record.filename,
    });
  });

  return router;
}

/** Express app speaking LibreChat's Code API (`LIBRECHAT_CODE_BASEURL=<origin>/v1`). */
export function createApp(deps: AppDependencies): express.Express {
  const { authenticate, logger } = deps;
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.principal = authenticate(req.get('authorization'));
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use('/v1', routes(deps));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', message: 'Not found' });
  });
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    sendError(error, res, logger);
  });
  return app;
}
