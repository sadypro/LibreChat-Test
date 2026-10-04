#!/usr/bin/env node
import { S3Client } from '@aws-sdk/client-s3';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { createAgentCoreInterpreter } from './sandbox/agentcore';
import { createS3Store } from './storage/s3';
import { createService } from './service';
import { createLogger } from './logger';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();
  const interpreter = createAgentCoreInterpreter({
    client: new BedrockAgentCoreClient({
      region: config.agentcore.region,
      ...(config.agentcore.endpoint != null ? { endpoint: config.agentcore.endpoint } : {}),
    }),
    codeInterpreterId: config.agentcore.codeInterpreterId,
  });
  const store = createS3Store({
    client: new S3Client({
      region: config.storage.region ?? config.agentcore.region,
      forcePathStyle: config.storage.forcePathStyle,
      ...(config.storage.endpoint != null ? { endpoint: config.storage.endpoint } : {}),
    }),
    bucket: config.storage.bucket,
    kmsKeyId: config.storage.kmsKeyId,
  });
  const service = createService({ config, interpreter, store, logger });
  const server = service.app.listen(config.server.port, config.server.host, () => {
    logger.info('server.listening', {
      host: config.server.host,
      port: config.server.port,
      codeInterpreterId: config.agentcore.codeInterpreterId,
    });
  });

  const stop = (signal: string): void => {
    logger.info('server.stopping', { signal });
    server.close();
    service
      .shutdown()
      .catch((error: Error) => logger.error('server.shutdown_failed', { error: error.message }))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
