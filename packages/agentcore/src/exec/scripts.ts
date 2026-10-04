/**
 * Shell programs the middleware runs inside an AgentCore session. Every value spliced into a
 * script is either single-quoted with `quote` or matched by a strict pattern first, so file
 * names, tool names and arguments supplied by a model can never break out into shell syntax.
 */

export const RUN_ROOT = '.lc';
export const SETUP_FAILED_EXIT = 97;

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Path-safe key for an input path, used to mark inputs inside the run directory. */
export function inputKey(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url');
}

export interface StagedInput {
  staged: string;
  target: string;
  readOnly: boolean;
}

export interface RunScriptOptions {
  runId: string;
  dataDir: string;
  inputs: StagedInput[];
  command: string;
  timeoutSeconds: number;
}

function prelude(runId: string, dataDir: string): string {
  return [`R="$PWD/${RUN_ROOT}/${runId}"`, `D=${quote(dataDir)}`].join('\n');
}

/**
 * `command` is spliced verbatim, so callers build it from `quote`d values and `$R`-relative paths.
 * Clears earlier runs and the data directory, moves staged inputs into place, then runs the
 * command from the data directory with its output captured to files. The exit code is written
 * last through a rename so a poller never reads a partial value.
 */
export function buildRunScript({
  runId,
  dataDir,
  inputs,
  command,
  timeoutSeconds,
}: RunScriptOptions): string {
  const moves = inputs.flatMap(({ staged, target, readOnly }) => {
    const slash = target.lastIndexOf('/');
    const lines = [
      ...(slash > 0 ? [`mkdir -p "$D"/${quote(target.slice(0, slash))} || fail`] : []),
      `mv "$R"/${quote(staged)} "$D"/${quote(target)} || fail`,
      `: > "$R/inputs/${inputKey(target)}"`,
    ];
    return readOnly ? [...lines, `chmod a-w "$D"/${quote(target)}`] : lines;
  });
  return [
    'set -u',
    prelude(runId, dataDir),
    'finish() { printf \'%s\' "$1" > "$R/exit.tmp" && mv "$R/exit.tmp" "$R/exit"; }',
    `fail() { : > "$R/setup_failed"; finish ${SETUP_FAILED_EXIT}; exit ${SETUP_FAILED_EXIT}; }`,
    `find "$PWD/${RUN_ROOT}" -mindepth 1 -maxdepth 1 ! -name ${quote(runId)} -exec rm -rf {} + 2>/dev/null`,
    'mkdir -p "$R/inputs" "$R/out" "$R/ipc/req" "$R/ipc/res" "$R/ipc/tmp" "$R/ipc/wip" || fail',
    'mkdir -p "$D" 2>/dev/null || fail',
    'find "$D" -mindepth 1 -delete 2>/dev/null',
    ...moves,
    'touch "$R/marker" || fail',
    'cd "$D" || fail',
    'export LIBRECHAT_CODE_DATA_DIR="$D" LC_RUN="$R" LC_IPC="$R/ipc" LC_TOOLS="$R/tools.json" LC_CODE="$R/code"',
    `timeout -k 5 ${Math.max(1, Math.ceil(timeoutSeconds))} ${command} > "$R/stdout" 2> "$R/stderr" < /dev/null`,
    'finish "$?"',
  ].join('\n');
}

export interface CollectOptions {
  runId: string;
  dataDir: string;
  inputTargets: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
  maxStdoutBytes: number;
}

/**
 * Prints a line-oriented manifest of the finished run: exit status, captured stream sizes, every
 * new or modified file under the data directory (copied into the run directory for reading),
 * skipped and deleted inputs. Paths are base64 so any byte sequence survives the protocol.
 */
export function buildCollectScript(options: CollectOptions): string {
  const { runId, dataDir, inputTargets, maxFiles, maxFileBytes, maxDepth, maxStdoutBytes } =
    options;
  const deletions = inputTargets.map(
    (target) =>
      `[ -e "$D"/${quote(target)} ] || printf 'DEL %s\\n' ${quote(Buffer.from(target).toString('base64'))}`,
  );
  return [
    prelude(runId, dataDir),
    '[ -f "$R/exit" ] && printf \'EXIT %s\\n\' "$(cat "$R/exit")"',
    '[ -f "$R/setup_failed" ] && printf \'SETUP_FAILED\\n\'',
    'for s in stdout stderr; do',
    '  size=$(stat -c %s "$R/$s" 2>/dev/null || echo 0)',
    '  printf \'STREAM %s %s\\n\' "$s" "$size"',
    `  head -c ${maxStdoutBytes} "$R/$s" > "$R/$s.cut" 2>/dev/null || : > "$R/$s.cut"`,
    'done',
    '[ -f "$R/marker" ] && cd "$D" 2>/dev/null && {',
    `  find . -mindepth 1 -maxdepth ${maxDepth} -type f -print0 | {`,
    '    i=0; n=0',
    "    while IFS= read -r -d '' p; do",
    '      p=${p#./}',
    "      key=$(printf '%s' \"$p\" | base64 -w0 | tr '+/' '-_' | tr -d '=')",
    '      if [ -e "$R/inputs/$key" ] && [ ! "$p" -nt "$R/marker" ]; then continue; fi',
    '      n=$((n+1))',
    `      [ "$n" -gt ${maxFiles} ] && continue`,
    '      size=$(stat -c %s "$p")',
    '      b64=$(printf \'%s\' "$p" | base64 -w0)',
    `      if [ "$size" -gt ${maxFileBytes} ]; then printf 'SKIP size %s\\n' "$b64"; continue; fi`,
    '      cp "$p" "$R/out/$i" && printf \'FILE %s %s %s\\n\' "$i" "$size" "$b64" && i=$((i+1))',
    '    done',
    `    [ "$n" -gt ${maxFiles} ] && printf 'TRUNC max_files %s\\n' $((n-${maxFiles}))`,
    '    :',
    '  }',
    '}',
    ...deletions,
    'exit 0',
  ].join('\n');
}

export interface PollOptions {
  runId: string;
  /** Call ids whose results were just staged under `ipc/tmp` and should be released. */
  answered: string[];
  collect: CollectOptions;
}

/**
 * One programmatic-execution poll: release staged tool results, then either report the finished
 * run (with its collect manifest) or list tool calls still waiting for a result.
 */
export function buildPollScript({ runId, answered, collect }: PollOptions): string {
  const releases = answered.map(
    (callId) => `[ -d "$I/tmp/${callId}" ] && mv "$I/tmp/${callId}" "$I/res/${callId}"`,
  );
  return [
    `I="$PWD/${RUN_ROOT}/${runId}/ipc"`,
    ...releases,
    `if [ -f "$PWD/${RUN_ROOT}/${runId}/exit" ]; then`,
    buildCollectScript(collect),
    'fi',
    'for d in "$I"/req/*; do',
    '  [ -d "$d" ] || continue',
    '  c=${d##*/}',
    '  [ -e "$I/res/$c" ] && continue',
    '  printf \'CALL %s %s %s\\n\' "$c" "$(base64 -w0 < "$d/name")" "$(base64 -w0 < "$d/input")"',
    'done',
    'exit 0',
  ].join('\n');
}

export const PYTHON_RUNNER = `import ast, asyncio, json, os, sys, traceback, uuid

_IPC = os.environ['LC_IPC']


async def _lc_call(name, payload):
    call_id = 'c' + uuid.uuid4().hex
    wip = os.path.join(_IPC, 'wip', call_id)
    os.makedirs(wip)
    with open(os.path.join(wip, 'name'), 'w', encoding='utf-8') as handle:
        handle.write(name)
    with open(os.path.join(wip, 'input'), 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, default=str)
    os.rename(wip, os.path.join(_IPC, 'req', call_id))
    result_dir = os.path.join(_IPC, 'res', call_id)
    delay = 0.02
    while not os.path.isdir(result_dir):
        await asyncio.sleep(delay)
        delay = min(delay * 1.5, 0.25)
    with open(os.path.join(result_dir, 'json'), encoding='utf-8') as handle:
        data = json.load(handle)
    if data.get('is_error'):
        raise RuntimeError(data.get('error_message') or 'Tool %s failed' % name)
    return _lc_decode(data.get('result'))


def _lc_decode(value):
    if isinstance(value, str) and value.strip()[:1] in ('{', '['):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _lc_tool(name):
    async def call(**kwargs):
        return await _lc_call(name, kwargs)
    call.__name__ = name
    return call


def _lc_main():
    with open(os.environ['LC_TOOLS'], encoding='utf-8') as handle:
        tools = json.load(handle)
    scope = {'__name__': '__main__', '__builtins__': __builtins__, 'asyncio': asyncio}
    for identifier, name in tools.items():
        scope[identifier] = _lc_tool(name)
    with open(os.environ['LC_CODE'], encoding='utf-8') as handle:
        source = handle.read()
    try:
        compiled = compile(source, '<code>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        result = eval(compiled, scope)
        if asyncio.iscoroutine(result):
            asyncio.run(result)
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        sys.exit(1)


_lc_main()
`;

const BASH_RUNNER_PRELUDE = `_lc_call() {
  local name="$1" input="\${2-}" call_id wip result_dir
  [ -n "$input" ] || input='{}'
  call_id="c$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
  wip="$LC_IPC/wip/$call_id"
  mkdir -p "$wip"
  printf '%s' "$name" > "$wip/name"
  printf '%s' "$input" > "$wip/input"
  mv "$wip" "$LC_IPC/req/$call_id"
  result_dir="$LC_IPC/res/$call_id"
  while [ ! -d "$result_dir" ]; do sleep 0.1; done
  if [ "$(cat "$result_dir/status")" = ok ]; then
    cat "$result_dir/value"; printf '\\n'
    return 0
  fi
  cat "$result_dir/value" >&2; printf '\\n' >&2
  return 1
}`;

/** Bash runner: one function per tool, then the user's script sourced into the same shell. */
export function buildBashRunner(tools: Record<string, string>): string {
  const functions = Object.entries(tools).map(
    ([identifier, name]) => `${identifier}() { _lc_call ${quote(name)} "$@"; }`,
  );
  return [BASH_RUNNER_PRELUDE, ...functions, '. "$LC_CODE"'].join('\n');
}
