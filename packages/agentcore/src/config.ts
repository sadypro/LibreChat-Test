import { z } from 'zod';

const booleanString = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** Command template for one Code API `lang`; `{file}` is the script path, `{args}` the quoted args. */
export const languageSchema = z.object({
  extension: z.string().regex(/^[a-z0-9]{1,8}$/),
  command: z.string().min(1).includes('{file}'),
});

export type LanguageConfig = z.infer<typeof languageSchema>;

/** Python, JavaScript and TypeScript are the AgentCore-supported runtimes; bash runs in its shell. */
export const DEFAULT_LANGUAGES: Record<string, LanguageConfig> = {
  py: { extension: 'py', command: 'python3 {file} {args}' },
  js: { extension: 'js', command: 'node {file} {args}' },
  ts: { extension: 'ts', command: 'deno run --allow-all --quiet {file} {args}' },
  bash: { extension: 'sh', command: 'bash {file} {args}' },
};

export const configSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: int(1, 65535).default(8790),
    jsonBodyLimitBytes: int(1024, 64 * 1024 * 1024).default(10 * 1024 * 1024),
  }),
  auth: z
    .object({
      /** PEM public key, or a public JWK as JSON. */
      publicKey: z.string().optional(),
      /** JWKS document (`{"keys":[...]}`) for key rotation; each key needs a `kid`. */
      jwks: z.string().optional(),
      kid: z.string().optional(),
      issuer: z.string().default('librechat'),
      audience: z.string().default('codeapi'),
      algorithms: z
        .array(z.enum(['EdDSA', 'RS256']))
        .min(1)
        .default(['EdDSA', 'RS256']),
      clockSkewSeconds: int(0, 300).default(30),
      maxTokenAgeSeconds: int(1, 3600).default(600),
      /** Tenant applied when a token carries no `tenant_id`; unset rejects such tokens. */
      defaultTenantId: z.string().optional(),
    })
    .refine((auth) => auth.publicKey != null || auth.jwks != null, {
      message: 'AGENTCORE_JWT_PUBLIC_KEY or AGENTCORE_JWT_JWKS is required',
    }),
  agentcore: z.object({
    region: z.string().min(1),
    endpoint: z.string().url().optional(),
    codeInterpreterId: z.string().min(1).default('aws.codeinterpreter.v1'),
    sessionTimeoutSeconds: int(60, 28_800).default(900),
    sessionIdleSeconds: int(5, 28_800).default(300),
    reuseSessions: booleanString.default(true),
    maxSessionsPerUser: int(1, 100).default(2),
    maxSessions: int(1, 10_000).default(50),
    acquireTimeoutMs: int(0, 300_000).default(10_000),
  }),
  storage: z.object({
    bucket: z.string().min(3),
    prefix: z
      .string()
      .default('librechat-code/')
      .transform((prefix) => (prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`)),
    region: z.string().optional(),
    endpoint: z.string().url().optional(),
    forcePathStyle: booleanString.default(false),
    kmsKeyId: z.string().optional(),
    fileTtlHours: int(1, 24 * 365).default(24),
  }),
  execution: z.object({
    dataDir: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/, 'dataDir must be an absolute path')
      .default('/mnt/data'),
    defaultTimeoutMs: int(1000, 3_600_000).default(60_000),
    maxTimeoutMs: int(1000, 3_600_000).default(300_000),
    maxStdoutBytes: int(1024, 16 * 1024 * 1024).default(262_144),
    maxInputFiles: int(0, 1000).default(100),
    maxInputBytes: int(0, 2 * 1024 * 1024 * 1024).default(150 * 1024 * 1024),
    maxOutputFiles: int(0, 1000).default(50),
    maxOutputFileBytes: int(0, 1024 * 1024 * 1024).default(50 * 1024 * 1024),
    maxOutputBytes: int(0, 2 * 1024 * 1024 * 1024).default(200 * 1024 * 1024),
    maxOutputDepth: int(1, 64).default(8),
    writeBatchBytes: int(64 * 1024, 100 * 1024 * 1024).default(8 * 1024 * 1024),
    languages: z
      .record(z.string().regex(/^[a-z0-9]{1,16}$/), languageSchema)
      .default(DEFAULT_LANGUAGES),
  }),
  programmatic: z.object({
    /** HMAC secret for continuation tokens; every replica must share it. */
    tokenSecret: z.string().min(32).optional(),
    maxDurationSeconds: int(10, 28_800).default(900),
    pollIntervalMs: int(20, 10_000).default(250),
    batchWindowMs: int(0, 10_000).default(100),
  }),
  uploads: z.object({
    maxFileBytes: int(1, 2 * 1024 * 1024 * 1024).default(150 * 1024 * 1024),
    maxBatchFiles: int(1, 1000).default(100),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw == null || raw.trim() === '' ? undefined : raw.trim();
}

function json<T>(env: Env, name: string): T | undefined {
  const raw = value(env, name);
  if (raw == null) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function list(env: Env, name: string): string[] | undefined {
  return value(env, name)
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function pem(raw: string | undefined): string | undefined {
  return raw?.replace(/\\n/g, '\n');
}

function defined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, entry]) => entry !== undefined)) as T;
}

/** Builds the service config from environment variables; throws with every invalid field listed. */
export function loadConfig(env: Env = process.env): Config {
  const base64Key = value(env, 'AGENTCORE_JWT_PUBLIC_KEY_BASE64');
  const region = value(env, 'AGENTCORE_REGION') ?? value(env, 'AWS_REGION');
  const input = {
    server: defined({
      host: value(env, 'HOST'),
      port: value(env, 'PORT'),
      jsonBodyLimitBytes: value(env, 'AGENTCORE_JSON_BODY_LIMIT_BYTES'),
    }),
    auth: defined({
      publicKey:
        pem(value(env, 'AGENTCORE_JWT_PUBLIC_KEY')) ??
        (base64Key != null ? Buffer.from(base64Key, 'base64').toString('utf8') : undefined),
      jwks: value(env, 'AGENTCORE_JWT_JWKS'),
      kid: value(env, 'AGENTCORE_JWT_KID'),
      issuer: value(env, 'AGENTCORE_JWT_ISSUER'),
      audience: value(env, 'AGENTCORE_JWT_AUDIENCE'),
      algorithms: list(env, 'AGENTCORE_JWT_ALGORITHMS'),
      clockSkewSeconds: value(env, 'AGENTCORE_JWT_CLOCK_SKEW_SECONDS'),
      maxTokenAgeSeconds: value(env, 'AGENTCORE_JWT_MAX_TOKEN_AGE_SECONDS'),
      defaultTenantId: value(env, 'AGENTCORE_JWT_DEFAULT_TENANT_ID'),
    }),
    agentcore: defined({
      region,
      endpoint: value(env, 'AGENTCORE_ENDPOINT'),
      codeInterpreterId: value(env, 'AGENTCORE_CODE_INTERPRETER_ID'),
      sessionTimeoutSeconds: value(env, 'AGENTCORE_SESSION_TIMEOUT_SECONDS'),
      sessionIdleSeconds: value(env, 'AGENTCORE_SESSION_IDLE_SECONDS'),
      reuseSessions: value(env, 'AGENTCORE_REUSE_SESSIONS'),
      maxSessionsPerUser: value(env, 'AGENTCORE_MAX_SESSIONS_PER_USER'),
      maxSessions: value(env, 'AGENTCORE_MAX_SESSIONS'),
      acquireTimeoutMs: value(env, 'AGENTCORE_ACQUIRE_TIMEOUT_MS'),
    }),
    storage: defined({
      bucket: value(env, 'AGENTCORE_S3_BUCKET'),
      prefix: env.AGENTCORE_S3_PREFIX,
      region: value(env, 'AGENTCORE_S3_REGION') ?? region,
      endpoint: value(env, 'AGENTCORE_S3_ENDPOINT'),
      forcePathStyle: value(env, 'AGENTCORE_S3_FORCE_PATH_STYLE'),
      kmsKeyId: value(env, 'AGENTCORE_S3_KMS_KEY_ID'),
      fileTtlHours: value(env, 'AGENTCORE_FILE_TTL_HOURS'),
    }),
    execution: defined({
      dataDir: value(env, 'AGENTCORE_DATA_DIR'),
      defaultTimeoutMs: value(env, 'AGENTCORE_EXEC_DEFAULT_TIMEOUT_MS'),
      maxTimeoutMs: value(env, 'AGENTCORE_EXEC_MAX_TIMEOUT_MS'),
      maxStdoutBytes: value(env, 'AGENTCORE_MAX_STDOUT_BYTES'),
      maxInputFiles: value(env, 'AGENTCORE_MAX_INPUT_FILES'),
      maxInputBytes: value(env, 'AGENTCORE_MAX_INPUT_BYTES'),
      maxOutputFiles: value(env, 'AGENTCORE_MAX_OUTPUT_FILES'),
      maxOutputFileBytes: value(env, 'AGENTCORE_MAX_OUTPUT_FILE_BYTES'),
      maxOutputBytes: value(env, 'AGENTCORE_MAX_OUTPUT_BYTES'),
      maxOutputDepth: value(env, 'AGENTCORE_MAX_OUTPUT_DEPTH'),
      writeBatchBytes: value(env, 'AGENTCORE_WRITE_BATCH_BYTES'),
      languages: json<Record<string, LanguageConfig>>(env, 'AGENTCORE_LANGUAGES'),
    }),
    programmatic: defined({
      tokenSecret: value(env, 'AGENTCORE_PROGRAMMATIC_TOKEN_SECRET'),
      maxDurationSeconds: value(env, 'AGENTCORE_PROGRAMMATIC_MAX_DURATION_SECONDS'),
      pollIntervalMs: value(env, 'AGENTCORE_PROGRAMMATIC_POLL_INTERVAL_MS'),
      batchWindowMs: value(env, 'AGENTCORE_PROGRAMMATIC_BATCH_WINDOW_MS'),
    }),
    uploads: defined({
      maxFileBytes: value(env, 'AGENTCORE_UPLOAD_MAX_FILE_BYTES'),
      maxBatchFiles: value(env, 'AGENTCORE_UPLOAD_MAX_BATCH_FILES'),
    }),
  };
  return parseConfig(input);
}

export function parseConfig(input: unknown): Config {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid AgentCore Code API configuration: ${issues}`);
  }
  return result.data;
}
