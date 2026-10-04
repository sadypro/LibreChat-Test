import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { LocalInterpreter } from './interpreter';
import type { ConfigInput } from '../../config';
import { createMemoryStore } from '../../storage/memory';
import { createLocalInterpreter } from './interpreter';
import { createService } from '../../service';
import { silentLogger } from '../../logger';
import { parseConfig } from '../../config';

export interface KeyPair {
  privateKey: KeyObject;
  publicPem: string;
}

export function createKeyPair(type: 'ed25519' | 'rsa' = 'ed25519'): KeyPair {
  const { privateKey, publicKey } =
    type === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Mints a token exactly the way LibreChat's `packages/api/src/auth/codeapi.ts` signs one. */
export function mintToken(
  privateKey: KeyObject,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const alg = privateKey.asymmetricKeyType === 'rsa' ? 'RS256' : 'EdDSA';
  const signingInput = `${b64({ alg, typ: 'JWT', kid: 'lc-codeapi-2026-05', ...header })}.${b64({
    iss: 'librechat',
    aud: 'codeapi',
    sub: 'user-a',
    iat: now,
    nbf: now,
    exp: now + 300,
    jti: randomBytes(8).toString('hex'),
    tenant_id: 'legacy',
    role: 'USER',
    ...claims,
  })}`;
  const signature = sign(
    alg === 'RS256' ? 'RSA-SHA256' : null,
    Buffer.from(signingInput),
    privateKey,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

export interface Harness {
  app: ReturnType<typeof createService>['app'];
  interpreter: LocalInterpreter;
  store: ReturnType<typeof createMemoryStore>;
  keys: KeyPair;
  dataDir: string;
  bearer(userId?: string, claims?: Record<string, unknown>): string;
  close(): Promise<void>;
}

export type Overrides = {
  [Section in keyof ConfigInput]?: Partial<NonNullable<ConfigInput[Section]>>;
};

export function testConfig(publicPem: string, dataDir: string, overrides: Overrides = {}) {
  return parseConfig({
    server: { ...overrides.server },
    auth: { publicKey: publicPem, ...overrides.auth },
    agentcore: { region: 'us-east-1', acquireTimeoutMs: 2000, ...overrides.agentcore },
    storage: { bucket: 'test-bucket', ...overrides.storage },
    execution: { dataDir, ...overrides.execution },
    programmatic: {
      tokenSecret: 'test-secret-test-secret-test-secret-0123',
      pollIntervalMs: 25,
      batchWindowMs: 50,
      ...overrides.programmatic,
    },
    uploads: { ...overrides.uploads },
  });
}

/** Full service over the local interpreter and an in-memory store; only AWS is substituted. */
export function createHarness(overrides: Overrides = {}): Harness {
  const keys = createKeyPair();
  const dataDir = join(tmpdir(), `lc-data-${randomBytes(6).toString('hex')}`);
  const interpreter = createLocalInterpreter();
  const store = createMemoryStore();
  const service = createService({
    config: testConfig(keys.publicPem, dataDir, overrides),
    interpreter,
    store,
    logger: silentLogger,
  });
  return {
    app: service.app,
    interpreter,
    store,
    keys,
    dataDir,
    bearer: (userId = 'user-a', claims = {}) =>
      `Bearer ${mintToken(keys.privateKey, { sub: userId, ...claims })}`,
    async close() {
      await service.shutdown();
      interpreter.cleanup();
    },
  };
}
