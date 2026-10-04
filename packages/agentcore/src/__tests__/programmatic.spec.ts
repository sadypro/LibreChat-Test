import request from 'supertest';
import type { Harness } from './helpers/setup';
import { createHarness } from './helpers/setup';

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

const tools = [{ name: 'get-weather' }, { name: 'lookup' }];

describe('POST /v1/exec/programmatic', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const post = (body: object, userId = 'user-a') =>
    request(harness.app)
      .post('/v1/exec/programmatic')
      .set('Authorization', harness.bearer(userId))
      .send(body);

  it('pauses python code on tool calls and resumes it with the results', async () => {
    const first = await post({
      code: [
        'sf, ny = await asyncio.gather(get_weather(city="SF"), get_weather(city="NY"))',
        'print(sf["temp"], ny["temp"])',
        'info = await lookup(key="k")',
        'print(info)',
        'open("report.txt", "w").write("done")',
      ].join('\n'),
      tools,
      timeout: 10_000,
    }).expect(200);

    expect(first.body.status).toBe('tool_call_required');
    const calls = first.body.tool_calls as ToolCall[];
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.name)).toEqual(['get-weather', 'get-weather']);
    expect(calls.map((call) => (call.input as { city: string }).city).sort()).toEqual(['NY', 'SF']);

    const second = await post({
      continuation_token: first.body.continuation_token,
      tool_results: calls.map((call) => ({
        call_id: call.id,
        result:
          (call.input as { city: string }).city === 'SF'
            ? { temp: 60 }
            : JSON.stringify({ temp: 40 }),
        is_error: false,
      })),
    }).expect(200);
    expect(second.body.status).toBe('tool_call_required');
    expect(second.body.tool_calls).toEqual([
      { id: expect.any(String), name: 'lookup', input: { key: 'k' } },
    ]);

    const done = await post({
      continuation_token: second.body.continuation_token,
      tool_results: [{ call_id: second.body.tool_calls[0].id, result: 'found', is_error: false }],
    }).expect(200);
    expect(done.body).toMatchObject({ status: 'completed', stdout: '60 40\nfound\n', stderr: '' });
    expect(done.body.files).toEqual([
      { id: expect.any(String), name: 'report.txt', storage_session_id: done.body.session_id },
    ]);
    expect(harness.interpreter.stopped).toHaveLength(1);
  });

  it('raises tool errors inside python', async () => {
    const first = await post({
      code: 'try:\n    await lookup(key="x")\nexcept RuntimeError as e:\n    print("caught", e)',
      tools,
    }).expect(200);
    const done = await post({
      continuation_token: first.body.continuation_token,
      tool_results: [
        {
          call_id: first.body.tool_calls[0].id,
          result: null,
          is_error: true,
          error_message: 'boom',
        },
      ],
    }).expect(200);
    expect(done.body.stdout).toBe('caught boom\n');
  });

  it('runs code with no tool calls straight to completion', async () => {
    const response = await post({ code: 'print(sum(range(5)))', tools }).expect(200);
    expect(response.body).toMatchObject({ status: 'completed', stdout: '10\n' });
  });

  it('exposes tools as bash functions that take JSON', async () => {
    const first = await post({
      lang: 'bash',
      code: 'data=$(get_weather \'{"city": "SF"}\')\necho "got:$data"',
      tools,
    }).expect(200);
    expect(first.body.tool_calls).toEqual([
      { id: expect.any(String), name: 'get-weather', input: { city: 'SF' } },
    ]);
    const done = await post({
      lang: 'bash',
      continuation_token: first.body.continuation_token,
      tool_results: [
        { call_id: first.body.tool_calls[0].id, result: { temp: 61 }, is_error: false },
      ],
    }).expect(200);
    expect(done.body.stdout).toBe('got:{"temp":61}\n');
  });

  it('binds continuation tokens to the user who started the run', async () => {
    const first = await post({ code: 'await lookup(key="x")', tools }).expect(200);
    const stolen = await post(
      { continuation_token: first.body.continuation_token, tool_results: [] },
      'user-b',
    ).expect(400);
    expect(stolen.body.error).toBe('continuation_invalid');

    const tampered = `${first.body.continuation_token.slice(0, -2)}xx`;
    await post({ continuation_token: tampered, tool_results: [] }).expect(400);
  });

  it('fails the run when an iteration exceeds its timeout', async () => {
    const response = await post({
      code: 'import time\ntime.sleep(5)',
      tools,
      timeout: 1000,
    }).expect(200);
    expect(response.body).toEqual({ status: 'error', error: 'Time limit exceeded' });
    expect(harness.interpreter.stopped).toHaveLength(1);
  });

  it('cancels an in-flight request by its request id', async () => {
    const pending = request(harness.app)
      .post('/v1/exec/programmatic')
      .set('Authorization', harness.bearer())
      .set('X-LibreChat-Code-Request-ID', 'req-1')
      .send({ code: 'import time\ntime.sleep(20)', tools, timeout: 15_000 });
    const response = pending.then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await request(harness.app)
      .post('/v1/exec/programmatic/cancel')
      .set('Authorization', harness.bearer('user-b'))
      .send({ request_id: 'req-1' })
      .expect(404);
    await request(harness.app)
      .post('/v1/exec/programmatic/cancel')
      .set('Authorization', harness.bearer())
      .send({ request_id: 'req-1' })
      .expect(200);

    const result = await response;
    expect(result.body).toEqual({ status: 'error', error: 'Execution failed or timed out' });
  });

  it('rejects colliding tool names', async () => {
    const response = await post({ code: 'pass', tools: [{ name: 'a-b' }, { name: 'a_b' }] }).expect(
      400,
    );
    expect(response.body.error).toBe('invalid_request');
  });
});
