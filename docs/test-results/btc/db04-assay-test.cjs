const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const sourcePath =
  process.argv[2] ??
  require("node:path").resolve(
    __dirname,
    "../../runbooks/btc-postgres-capacity.md",
  );
const source = fs
  .readFileSync(sourcePath, "utf8")
  .match(/```javascript\n([\s\S]*?)\n```/)[1];
const roles = [
  "mesa",
  "carteira",
  "decisoes",
  "sombra",
  "resolucao",
  "sistema",
];
const quotas = [320, 320, 220, 200, 550, 590];
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
};
function scenario(
  behave = () =>
    new Response('{"sentinel_body":"DO_NOT_RECORD"}', { status: 200 }),
) {
  let now = 1800000000000,
    serial = 0;
  const start = now + 1000,
    end = start + 900000,
    timers = new Map(),
    channels = [],
    calls = [];
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  class Channel {
    constructor(name) {
      this.name = name;
      channels.push(this);
    }
    postMessage(data) {
      for (const peer of channels)
        if (peer !== this && peer.name === this.name)
          queueMicrotask(() =>
            peer.onmessage?.({ data: structuredClone(data) }),
          );
    }
  }
  const tick = (target) => {
    while (true) {
      const next = [...timers]
        .filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = target;
  };
  function page(role) {
    const window = {
      fetch: (input, init) => {
        calls.push({
          role,
          input: String(input),
          method: init?.method ?? "GET",
        });
        if (init?.signal?.aborted)
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        return Promise.resolve(behave(role, input, init));
      },
    };
    const ctx = vm.createContext({
      window,
      location: {
        href: "https://example.test/",
        origin: "https://example.test",
      },
      Date: ClockDate,
      URL,
      Request,
      DOMException,
      AbortController,
      BroadcastChannel: Channel,
      crypto: { randomUUID: () => "instance-" + ++serial },
      performance: { now: () => now },
      setTimeout(fn, ms) {
        const id = ++serial;
        timers.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    });
    vm.runInContext(
      source.replace(
        /const cfg = \{[\s\S]*?\};/,
        "const cfg = " +
          JSON.stringify({ role, startUtc: new Date(start).toISOString() }) +
          ";",
      ),
      ctx,
    );
    return window;
  }
  async function six() {
    const pages = roles.map(page);
    await flush();
    return pages;
  }
  return { page, six, tick, calls, start, end, now: () => now };
}
const results = [];
async function test(name, run) {
  await run();
  results.push(name);
}
(async () => {
  await test("six roles, body completion, privacy, no autonomous requests", async () => {
    const s = scenario(),
      p = await s.six();
    assert.equal(s.calls.length, 0);
    s.tick(s.start);
    for (const w of p) {
      assert.equal(w.__db04Assay.snapshot().readyRoles.length, 6);
      await w.fetch(
        "/api/polymarket/shadow-replay/latest?mode=A&access_token=DO_NOT_RECORD",
        {
          headers: { authorization: "Bearer DO_NOT_RECORD" },
          credentials: "include",
        },
      );
    }
    await flush();
    for (const w of p) {
      const snapshot = w.__db04Assay.snapshot();
      assert.equal(snapshot.active, 0);
      assert.equal(snapshot.samples[0].outcome, "ok");
      assert.equal(
        snapshot.samples[0].route,
        "/polymarket/shadow-replay/latest?mode=A",
      );
      assert.ok(!JSON.stringify(snapshot).includes("DO_NOT_RECORD"));
    }
  });
  await test("all six quota boundaries total 2200 and no 2201st fetch", async () => {
    // Independent six-page scenario for each quota avoids a first quota abort
    // preventing verification of the other five boundaries.
    for (let role = 0; role < 6; role++) {
      const s = scenario(),
        p = await s.six();
      s.tick(s.start);
      for (let n = 0; n < quotas[role]; n++)
        await p[role].fetch("/api/health/live");
      await flush();
      await assert.rejects(p[role].fetch("/api/health/live"), {
        name: "AbortError",
      });
      await flush();
      assert.equal(s.calls.length, quotas[role]);
      assert.equal(p[role].__db04Assay.snapshot().initiated, quotas[role]);
      for (const w of p)
        assert.equal(w.__db04Assay.snapshot().stopped.reason, "request_quota");
    }
    assert.equal(
      quotas.reduce((a, b) => a + b, 0),
      2200,
    );
  });
  await test("response returned at headers while duration waits for full body", async () => {
    let bodyDone;
    const s = scenario(() => ({
      ok: true,
      status: 200,
      clone: () => ({
        arrayBuffer: () =>
          new Promise((resolve) => {
            bodyDone = resolve;
          }),
      }),
    }));
    const p = await s.six();
    s.tick(s.start);
    await p[0].fetch("/api/health/live");
    assert.equal(p[0].__db04Assay.snapshot().samples[0].outcome, "inflight");
    s.tick(s.start + 120);
    bodyDone(new ArrayBuffer(0));
    await flush();
    assert.equal(p[0].__db04Assay.snapshot().samples[0].bodyCompleteMs, 120);
    assert.equal(p[0].__db04Assay.snapshot().samples[0].outcome, "ok");
  });
  await test("missing role aborts before network", async () => {
    const s = scenario(),
      p = s.page("mesa");
    await flush();
    s.tick(s.start);
    await assert.rejects(p.fetch("/api/health/live"), { name: "AbortError" });
    assert.equal(s.calls.length, 0);
    assert.equal(p.__db04Assay.snapshot().stopped.reason, "missing_role");
  });
  await test("duplicate role aborts all pages", async () => {
    const s = scenario(),
      p = await s.six();
    s.page("mesa");
    await flush();
    for (const w of p)
      assert.equal(w.__db04Assay.snapshot().stopped.reason, "duplicate_role");
    assert.equal(s.calls.length, 0);
  });
  await test("POST blocked before underlying fetch", async () => {
    const s = scenario(),
      p = await s.six();
    s.tick(s.start);
    await assert.rejects(
      p[0].fetch("/api/polymarket/paper/kill-switch/rearm", { method: "POST" }),
      { name: "AbortError" },
    );
    await flush();
    assert.equal(s.calls.length, 0);
    for (const w of p)
      assert.equal(
        w.__db04Assay.snapshot().stopped.reason,
        "unexpected_method",
      );
  });
  await test("HTTP 500 broadcasts stop", async () => {
    const s = scenario(() => new Response("failure", { status: 500 })),
      p = await s.six();
    s.tick(s.start);
    assert.equal((await p[0].fetch("/api/health/live")).status, 500);
    await flush();
    for (const w of p)
      assert.equal(w.__db04Assay.snapshot().stopped.reason, "http_error");
    assert.equal(p[0].__db04Assay.snapshot().samples[0].status, 500);
  });
  await test("body failure broadcasts stop without storing body", async () => {
    const s = scenario(() => ({
      ok: true,
      status: 200,
      clone: () => ({
        arrayBuffer: () => Promise.reject(new Error("DO_NOT_RECORD")),
      }),
    }));
    const p = await s.six();
    s.tick(s.start);
    await p[0].fetch("/api/health/live");
    await flush();
    for (const w of p)
      assert.equal(w.__db04Assay.snapshot().stopped.reason, "body_error");
    assert.ok(
      !JSON.stringify(p[0].__db04Assay.snapshot()).includes("DO_NOT_RECORD"),
    );
  });
  await test("5-second fetch timeout aborts and broadcasts", async () => {
    const s = scenario(
      (_role, _input, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    const p = await s.six();
    s.tick(s.start);
    const pending = p[0].fetch("/api/health/live");
    const rejection = assert.rejects(pending, { name: "AbortError" });
    s.tick(s.start + 5000);
    await rejection;
    await flush();
    for (const w of p)
      assert.equal(w.__db04Assay.snapshot().stopped.reason, "fetch_error");
    assert.equal(p[0].__db04Assay.snapshot().samples[0].bodyCompleteMs, 5000);
  });
  await test("normal deadline blocks further fetches", async () => {
    const s = scenario(),
      p = await s.six();
    s.tick(s.start);
    await p[0].fetch("/api/health/live");
    await flush();
    s.tick(s.end);
    await assert.rejects(p[0].fetch("/api/health/live"), {
      name: "AbortError",
    });
    assert.equal(s.calls.length, 1);
    for (const w of p)
      assert.equal(w.__db04Assay.snapshot().stopped.reason, "window_complete");
  });
  await test("inflight failure after normal deadline remains a propagated failure", async () => {
    let bodyFailed;
    const s = scenario(() => ({
      ok: true,
      status: 200,
      clone: () => ({
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            bodyFailed = reject;
          }),
      }),
    }));
    const p = await s.six();
    s.tick(s.end - 100);
    await p[0].fetch("/api/health/live");
    s.tick(s.end);
    assert.equal(p[0].__db04Assay.snapshot().stopped.reason, "window_complete");
    bodyFailed(new Error("body transport failed"));
    await flush();
    for (const w of p)
      assert.equal(w.__db04Assay.snapshot().stopped.reason, "body_error");
  });
  await test("explicit operator abort propagates", async () => {
    const s = scenario(),
      p = await s.six();
    p[0].__db04Assay.stop("operator_abort");
    await flush();
    for (const w of p)
      assert.equal(w.__db04Assay.snapshot().stopped.reason, "operator_abort");
    assert.equal(s.calls.length, 0);
  });
  console.log(
    JSON.stringify(
      {
        testedAtUtc: new Date().toISOString(),
        source: sourcePath,
        environment:
          "Node VM, six simulated same-origin pages; in-memory fetch only; no network/PostgreSQL",
        passed: results.length,
        checks: results,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
