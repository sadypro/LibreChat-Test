import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type { CodeInterpreter } from './sandbox/types';
import type { ObjectStore } from './storage/types';
import type { Config } from './config';
import type { Logger } from './logger';
import { createProgrammaticRunner } from './exec/programmatic';
import { createFileService } from './storage/files';
import { createSessionPool } from './sandbox/pool';
import { createTokenCodec } from './exec/token';
import { createAuthenticator } from './auth';
import { createExecutor } from './exec/run';
import { createApp } from './http/app';

export interface ServiceDependencies {
  config: Config;
  interpreter: CodeInterpreter;
  store: ObjectStore;
  logger: Logger;
  now?: () => number;
}

export interface Service {
  app: Express;
  shutdown(): Promise<void>;
}

/** Wires the service from injected integrations; no module reaches for globals or singletons. */
export function createService({
  config,
  interpreter,
  store,
  logger,
  now = Date.now,
}: ServiceDependencies): Service {
  const files = createFileService({
    store,
    prefix: config.storage.prefix,
    ttlHours: config.storage.fileTtlHours,
    now,
  });
  const pool = createSessionPool({ interpreter, config: config.agentcore, logger, now });
  const tokenSecret = config.programmatic.tokenSecret;
  if (tokenSecret == null) {
    logger.warn('programmatic.token_secret.generated', {
      detail:
        'AGENTCORE_PROGRAMMATIC_TOKEN_SECRET is unset; continuations only resume on this replica',
    });
  }
  const tokens = createTokenCodec(tokenSecret ?? randomBytes(32).toString('hex'));
  const executor = createExecutor({ interpreter, pool, files, config: config.execution });
  const programmatic = createProgrammaticRunner({
    interpreter,
    pool,
    files,
    tokens,
    execution: config.execution,
    config: config.programmatic,
    logger,
    now,
  });
  const app = createApp({
    config,
    authenticate: createAuthenticator(config.auth, now),
    executor,
    programmatic,
    files,
    logger,
  });
  return {
    app,
    async shutdown() {
      await programmatic.shutdown();
      await pool.shutdown();
    },
  };
}
