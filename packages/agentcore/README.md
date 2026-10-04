# @librechat/agentcore

A standalone service that implements LibreChat's **Code API**: the HTTP contract that
`@librechat/agents` and LibreChat's file handling call through `LIBRECHAT_CODE_BASEURL`. It runs
code in **Amazon Bedrock AgentCore Code Interpreter** sandboxes and keeps uploaded and generated
files in **S3**, isolated per user.

LibreChat needs no code change. Point it at this service and the `execute_code` tool, agent file
uploads, generated-file downloads, and programmatic tool calling (`run_tools_with_code` /
`run_tools_with_bash`) all run on AgentCore.

```
LibreChat ──(per-user JWT)──▶ agentcore middleware ──▶ AgentCore Code Interpreter
                                     │                  (one session per user, never shared)
                                     └──────────────▶ S3 (key prefix per tenant+user)
```

## Supported endpoints

| Method | Path (base includes `/v1`)                 | Backed by                                          |
| ------ | ------------------------------------------ | -------------------------------------------------- |
| POST   | `/exec`                                    | `writeFiles` → `executeCommand` → `readFiles`      |
| POST   | `/exec/programmatic`                       | `startCommandExecution` + file-based tool-call IPC |
| POST   | `/exec/programmatic/cancel`                | `stopTask` + session stop                          |
| POST   | `/upload`, `/upload/batch`                 | S3                                                 |
| GET    | `/download/{session}/{file}`               | S3 (streamed)                                      |
| GET    | `/files/{session}`                         | S3 listing (liveness and `fetchSessionFiles`)      |
| DELETE | `/files/{session}/{file}`                  | S3                                                 |
| GET    | `/sessions/{session}/objects/{file}`       | S3 metadata (re-upload freshness check)            |
| GET    | `/health` (no `/v1`, unauthenticated)      | —                                                  |

Languages: `py`, `js`, `ts` (Deno) and `bash` by default. Any other `lang` returns
`unsupported_capability`, which LibreChat treats as a permanent capability error.
`AGENTCORE_LANGUAGES` replaces the table if your interpreter image has more toolchains.

The bridge and workspace-tools endpoints (`/bridge/*`, `/workspace-tools/execute`) serve
self-hosted attached workers. They are not implemented here, and neither is the stateful profile
(`runtime_session_hint`). Every run is stateless, which is the default profile.

## Per-user isolation

- **Authentication.** Every `/v1` request must carry the EdDSA or RS256 JWT that LibreChat mints
  per user (`CODEAPI_AUTH_PROVIDER=librechat-jwt`). The service checks the signature, `iss`, `aud`,
  `exp`/`nbf` and the token's lifetime. The principal is `(tenant_id, sub)`. A forged or missing
  token returns `401` before any sandbox or storage call is made.
- **Storage.** Object keys are `<prefix><sha256(tenant, user)>/<session>/<file>`. The namespace is
  derived only from the verified principal, and ids from the client must match `[A-Za-z0-9_-]`.
  Another user's session or file id therefore resolves to nothing (`404`) for download, listing,
  metadata, delete and `/exec` inputs. Raw user ids never appear in keys. Objects are written with
  SSE-KMS when `AGENTCORE_S3_KMS_KEY_ID` is set, and SSE-S3 otherwise.
- **Sandboxes.** A session is leased only to the principal that started it. Per-user and global
  limits apply, and an idle session is stopped after `AGENTCORE_SESSION_IDLE_SECONDS`. Each run
  starts from an empty data directory, so even the same user's earlier conversations leave nothing
  behind. Set `AGENTCORE_REUSE_SESSIONS=false` for a brand-new microVM per run.
- **Programmatic continuations.** The token is HMAC-signed and bound to the principal, the session
  and the run. Another user cannot resume or cancel your run.
- **Errors.** Clients get stable codes (`rate_limited`, `sandbox_unavailable`, …). AWS error
  detail is only logged.

Agent and skill files are also stored per user. When a second user runs an agent whose files the
first user provisioned, LibreChat's liveness check gets `404` and re-uploads the files into the
second user's namespace.

## How a run works

1. Input files referenced in the `files` array are read from the caller's S3 namespace.
2. A session is leased from the caller's pool. Inputs, the code and two scripts are written with
   `writeFiles` (batched by `AGENTCORE_WRITE_BATCH_BYTES`).
3. One `executeCommand` runs both scripts. The first clears the data directory (`/mnt/data` by
   default, where LibreChat tells models to write files) and moves the inputs in. It then runs the
   code under `timeout` with stdout and stderr captured. The second lists every new or modified
   file and every deleted input.
4. One `readFiles` returns the streams and outputs. Outputs go to a new S3 session and are
   returned as `files`, so LibreChat downloads them from `/download`.

Programmatic tool calling runs the code with `startCommandExecution` in a dedicated session.
Python gets an `async` function per tool. Bash gets a shell function per tool that takes a JSON
string. Names are normalized exactly as `@librechat/agents` does it. Each tool call is written to
an IPC directory, and the middleware polls it and returns `tool_call_required`. The next request
writes the results back and the code resumes.

## Configuration

Configuration comes from environment variables, validated at startup. See
[`.env.example`](./.env.example) for every variable and its default. The required ones are:

| Variable                              | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `AWS_REGION` / `AGENTCORE_REGION`     | AgentCore (and default S3) region                                 |
| `AGENTCORE_S3_BUCKET`                 | Bucket for uploaded and generated files                           |
| `AGENTCORE_JWT_PUBLIC_KEY` or `_JWKS` | Verifier for LibreChat's `CODEAPI_JWT_PRIVATE_KEY`                |
| `AGENTCORE_PROGRAMMATIC_TOKEN_SECRET` | Shared HMAC secret. Without it, continuations only work on the replica that started the run |

AWS credentials come from the default provider chain: an instance or task role, env vars, or SSO.

### IAM permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:StartCodeInterpreterSession",
        "bedrock-agentcore:InvokeCodeInterpreter",
        "bedrock-agentcore:StopCodeInterpreterSession"
      ],
      "Resource": "arn:aws:bedrock-agentcore:<region>:aws:code-interpreter/aws.codeinterpreter.v1"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<bucket>/librechat-code/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<bucket>",
      "Condition": { "StringLike": { "s3:prefix": "librechat-code/*" } }
    }
  ]
}
```

If you use a custom code interpreter, adjust its resource ARN, and add `kms:GenerateDataKey` and
`kms:Decrypt` when using SSE-KMS. Add an S3 lifecycle rule that expires the prefix after
`AGENTCORE_FILE_TTL_HOURS`. The service already treats older objects as gone, and the rule
reclaims the storage.

### LibreChat side

```env
LIBRECHAT_CODE_BASEURL=http://agentcore-codeapi:8790/v1
CODEAPI_AUTH_PROVIDER=librechat-jwt
CODEAPI_JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
# CODEAPI_JWT_ALGORITHM=EdDSA   CODEAPI_JWT_ISSUER=librechat   CODEAPI_JWT_AUDIENCE=codeapi
```

Generate a key pair and give the public half to this service:

```sh
openssl genpkey -algorithm ed25519 -out codeapi.key
openssl pkey -in codeapi.key -pubout -out codeapi.pub
```

## Running

```sh
# From the repository root
npm ci --workspace packages/agentcore
npm run build --workspace packages/agentcore
node packages/agentcore/dist/server.js

# Or as a container
docker build -f packages/agentcore/Dockerfile -t librechat-agentcore .
```

`docker-compose.override.yml` example:

```yaml
services:
  agentcore-codeapi:
    build:
      context: .
      dockerfile: packages/agentcore/Dockerfile
    env_file: packages/agentcore/.env
    restart: always
  api:
    environment:
      - LIBRECHAT_CODE_BASEURL=http://agentcore-codeapi:8790/v1
      - CODEAPI_AUTH_PROVIDER=librechat-jwt
```

## Verify on a real AgentCore account first

The tests run the real scripts against a local stand-in for AgentCore. These assumptions about the
managed sandbox still need checking on your account:

- `writeFiles`/`readFiles` relative paths resolve against the same directory `executeCommand`
  starts in.
- The sandbox user can create and clear `AGENTCORE_DATA_DIR` (`/mnt/data`). If it cannot, `/exec`
  returns `sandbox_setup_failed`. Point the variable at a writable directory, keeping in mind that
  models are prompted to use `/mnt/data`.
- `bash`, coreutils `timeout`/`stat`/`base64`, `find` with `-print0`, `python3` and `node` are on
  `PATH`, and `deno` is too if you keep `ts`.
- `startCommandExecution` keeps running in the background until `stopTask` or session stop.

## Development

```sh
cd packages/agentcore
npx tsc --noEmit
npx jest
```

The tests exercise the real HTTP app, scripts, S3 key layout and IPC protocol. Only AWS is
substituted: a local `CodeInterpreter` runs the scripts in temporary directories, and an in-memory
store stands in for S3.
