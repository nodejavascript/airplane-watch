/**
 * rollbar.test.js — the tests for the Rollbar notifier, and for the guard in the
 * Worker that calls it.
 *
 * Three kinds of claim are checked here, and they are different things:
 *
 *   1. **The payload is the shape Rollbar documented**, including the frame order,
 *      which is the one field it is easy to get backwards.
 *   2. **What is deliberately NOT sent, is not sent** — no `person`, no `user_ip`,
 *      and no query string. A privacy claim that only lives in a comment is a
 *      comment, so each of those is asserted against the built payload.
 *   3. **The reporter cannot take the site down with it** — a missing token, a
 *      refused POST and a thrown fetch all have to end in `false`, not in an
 *      exception, and the Worker has to answer a real 503 when the proxy throws.
 *
 * No test here reaches the network. The one that exercises the Worker stubs the
 * single global it depends on and never leaves the process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildItem, framesFromStack, report, reportFailure } from '../worker/rollbar.js';
import worker from '../worker/index.js';

const ROLLBAR_URL = 'https://api.rollbar.com/api/1/item/';

/** A real V8 stack, as this runtime prints one: most recent call FIRST. */
const STACK = [
  'TypeError: Cannot read properties of undefined (reading \'text\')',
  '    at serveFeed (worker/index.js:700:31)',
  '    at async Object.fetch (worker/index.js:712:12)',
  '    at async https://airplane-watch.nodejavascript.com/api/v2/hex/abc123:443:1',
].join('\n');

/** Replace the global fetch for the duration of one test, then put it back. */
async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/* ------------------------------------------------------- framesFromStack --- */

test('framesFromStack puts the most recent call LAST, which is the order Rollbar documents', () => {
  // docs.rollbar.com/reference/create-item: frames is "a list of stack frames,
  // ordered such that the most recent call is last in the list". V8 prints the
  // most recent call FIRST, so this test is the reversal and nothing else.
  const frames = framesFromStack(STACK);

  assert.equal(frames.length, 3);
  // Reversed: the outermost call leads the list and the innermost call ends it,
  // which is the opposite of the stack V8 printed.
  assert.equal(frames[0].method, '', 'the outermost frame is the anonymous one');
  assert.equal(frames[1].method, 'Object.fetch');
  assert.equal(frames[frames.length - 1].method, 'serveFeed', 'the most recent call is LAST');
});

test('framesFromStack reads file, line and column off a frame', () => {
  const innermost = framesFromStack(STACK).at(-1);

  assert.equal(innermost.filename, 'worker/index.js');
  assert.equal(innermost.lineno, 700);
  assert.equal(innermost.colno, 31);
});

test('framesFromStack strips the async prefix and keeps an anonymous frame anonymous', () => {
  const frames = framesFromStack(
    ['Error: bad', '    at async load (site/app.js:1:2)', '    at site/app.js:9:8'].join('\n')
  );

  // Reversed: the anonymous frame comes first in the output.
  assert.deepEqual(frames, [
    { filename: 'site/app.js', lineno: 9, colno: 8, method: '' },
    { filename: 'site/app.js', lineno: 1, colno: 2, method: 'load' },
  ]);
});

test('framesFromStack keeps a filename that contains colons whole', () => {
  // A URL in a frame is the normal case in a Worker, and splitting on every colon
  // would hand Rollbar a filename of "https".
  const frames = framesFromStack('Error: x\n    at https://example.com/a.js:12:5');

  assert.equal(frames.length, 1);
  assert.equal(frames[0].filename, 'https://example.com/a.js');
  assert.equal(frames[0].lineno, 12);
});

test('framesFromStack returns nothing for a stack that is absent or not a stack', () => {
  assert.deepEqual(framesFromStack(undefined), []);
  assert.deepEqual(framesFromStack(''), []);
  assert.deepEqual(framesFromStack('Error: no frames here'), []);
});

/* ------------------------------------------------------------- buildItem --- */

test('buildItem sends the fields Rollbar requires, with production as the default environment', () => {
  const item = buildItem(new Error('boom'), {}, {});

  assert.equal(item.environment, 'production');
  assert.equal(item.level, 'error');
  assert.equal(item.language, 'javascript');
  assert.equal(item.platform, 'node');
  assert.equal(typeof item.timestamp, 'number');
  assert.equal(item.notifier.name, 'airplane-watch');
});

test('buildItem takes the environment from the Worker environment when it is set', () => {
  assert.equal(buildItem(new Error('boom'), {}, { ROLLBAR_ENVIRONMENT: 'staging' }).environment, 'staging');
});

test('buildItem uses context for the route, because that is the field Rollbar indexes', () => {
  const item = buildItem(new Error('boom'), { route: '/api/v2/hex/abc123' }, {});

  assert.equal(item.context, '/api/v2/hex/abc123');
  assert.equal(item.custom.route, '/api/v2/hex/abc123');
  assert.equal(item.request.method, '');
});

test('buildItem never sends a query string, a person or a visitor IP', () => {
  // This is the privacy claim in the module header, asserted rather than asserted
  // in prose. The query is where a visitor's own search lives — the tail number
  // or the place they are watching — and a page about aircraft has no business
  // telling a third party what any one reader was looking for.
  const item = buildItem(
    new Error('boom'),
    { origin: 'https://airplane-watch.nodejavascript.com', route: '/api/v2/hex/abc123', method: 'GET' },
    {}
  );

  assert.equal(item.request.url, 'https://airplane-watch.nodejavascript.com/api/v2/hex/abc123');
  assert.equal(item.request.url.includes('?'), false);

  const serialised = JSON.stringify(item);
  assert.equal(serialised.includes('"person"'), false);
  assert.equal(serialised.includes('user_ip'), false);
});

test('buildItem sends a trace when the stack parses, and a message item when there is none', () => {
  const traced = buildItem(new Error('boom'), { route: '/x' }, {});
  assert.equal(traced.body.trace.exception.class, 'Error');
  assert.equal(traced.body.trace.exception.message, 'boom');
  assert.equal(traced.body.message, undefined);
  assert.equal(traced.custom.stack, undefined, 'a parsed trace does not need the raw text too');

  // A thrown string has no stack at all, so the item becomes a message whose text
  // is still the only traceback there is.
  const thrown = buildItem('just a string', { route: '/x' }, {});
  assert.equal(thrown.body.message.body, 'Non-error thrown: just a string');
  assert.equal(thrown.body.trace, undefined);
});

test('buildItem reports only the version when the runtime provides one', () => {
  const withVersion = buildItem(new Error('x'), {}, { CF_VERSION_METADATA: { id: 'abc123' } });
  const without = buildItem(new Error('x'), {}, {});

  assert.equal(withVersion.server.code_version, 'abc123');
  assert.equal(without.server.code_version, undefined);
});

/* ---------------------------------------------------------------- report --- */

test('report is a no-op without a token, so an unconfigured proxy behaves as it did before', async () => {
  let called = false;
  await withFetch(async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }, async () => {
    assert.equal(await report({}, new Error('boom'), {}), false);
    assert.equal(await report({ ROLLBAR_SERVER_TOKEN: '' }, new Error('boom'), {}), false);
  });

  assert.equal(called, false, 'no token means no request at all');
});

test('report posts the item with the token in the header', async () => {
  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('{"err":0}', { status: 200 });
    },
    async () => {
      assert.equal(
        await report({ ROLLBAR_SERVER_TOKEN: 'tok_123' }, new Error('boom'), { route: '/x' }),
        true
      );
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ROLLBAR_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-rollbar-access-token'], 'tok_123');

  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.data.body.trace.exception.message, 'boom');
  assert.equal(payload.data.context, '/x');
});

test('report answers false rather than throwing when Rollbar refuses or the network fails', async () => {
  await withFetch(async () => new Response('nope', { status: 500 }), async () => {
    assert.equal(await report({ ROLLBAR_SERVER_TOKEN: 'tok' }, new Error('x'), {}), false);
  });

  await withFetch(
    async () => {
      throw new TypeError('network down');
    },
    async () => {
      assert.equal(await report({ ROLLBAR_SERVER_TOKEN: 'tok' }, new Error('x'), {}), false);
    }
  );
});

test('a rejected report logs Rollbar\'s own reason, because the status alone lies', async () => {
  // Measured 23 Sep 2026: an account with no active plan answers 429 — the same code
  // as a rate limit — while its rate-limit headers read 49,998 of 50,000 remaining.
  // The body is the only thing that tells the two apart, so it is the only thing
  // worth putting in the Worker's own log.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await withFetch(
      async () =>
        new Response('{"err":1,"message":"This account has been deactivated."}', {
          status: 429,
          headers: { 'x-rate-limit-remaining': '49998' },
        }),
      async () => {
        assert.equal(await report({ ROLLBAR_SERVER_TOKEN: 'tok' }, new Error('x'), {}), false);
      }
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /429/);
  assert.match(warnings[0], /deactivated/);
});

test('reportFailure hands the work to ctx.waitUntil instead of awaiting it', async () => {
  const scheduled = [];
  const request = new Request('https://airplane-watch.nodejavascript.com/api/v2/hex/abc123?t=1');

  await withFetch(
    async () => new Response('{"err":0}', { status: 200 }),
    async () => {
      reportFailure({ ROLLBAR_SERVER_TOKEN: 'tok' }, { waitUntil: (p) => scheduled.push(p) }, new Error('x'), request);

      // Scheduled, not awaited — but it did get scheduled, which is what keeps the
      // POST alive after the visitor's response has gone out.
      assert.equal(scheduled.length, 1);
      await Promise.all(scheduled);
    }
  );
});

/* ------------------------------------------- the guard around the Worker --- */

test('an unexpected throw in the proxy answers 503 and is reported, not leaked', async () => {
  const reports = [];
  const scheduled = [];

  await withFetch(
    async (url, init) => {
      const href = String(url);
      if (href.startsWith(ROLLBAR_URL)) {
        reports.push({ href, init });
        return new Response('{"err":0}', { status: 200 });
      }
      // The feed answers with something that is not a Response at all. Nothing in
      // the proxy is watching for that, which is exactly the fault this guard
      // exists for.
      return undefined;
    },
    async () => {
      const request = new Request('https://airplane-watch.nodejavascript.com/api/v2/hex/abc123?t=1');
      const env = { FEED_TOKEN: 'feed-token', ROLLBAR_SERVER_TOKEN: 'rollbar-token' };
      const ctx = { waitUntil: (promise) => scheduled.push(promise) };

      const response = await worker.fetch(request, env, ctx);

      assert.equal(response.status, 503, 'never 502 — the edge would replace the body');
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'This proxy hit an unexpected error answering that request.');

      assert.equal(scheduled.length, 1, 'the report is kept alive with ctx.waitUntil');
      await Promise.all(scheduled);
    }
  );

  assert.equal(reports.length, 1, 'exactly one report reached Rollbar');
  const payload = JSON.parse(reports[0].init.body);
  assert.match(payload.data.body.trace.exception.message, /text/);
  assert.equal(payload.data.context, '/api/v2/hex/abc123');
  assert.equal(payload.data.environment, 'production');
});

test('the guard leaves a working path alone', async () => {
  // A guard that changed the happy path would be worse than no guard: this proves
  // the proxy still answers straight through it.
  await withFetch(
    async () => new Response('{"ac":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    async () => {
      const request = new Request('https://airplane-watch.nodejavascript.com/api/v2/hex/def456');
      const response = await worker.fetch(
        request,
        { FEED_TOKEN: 'feed-token', ROLLBAR_SERVER_TOKEN: 'rollbar-token' },
        { waitUntil: () => {} }
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"ac":[]}');
    }
  );
});
