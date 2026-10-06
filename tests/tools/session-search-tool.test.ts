import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSessionSearchTool } from "../../src/tools/session-search-tool.js";
import { DatabaseManager } from "../../src/store/db.js";
import { indexAllSessions, indexSession } from "../../src/store/session-indexer.js";

let ROOT_DIR = "";

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = "";
});

function makeSessionsDir(): string {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-tool-test-"));
  return ROOT_DIR;
}

describe("registerSessionSearchTool", () => {
  it("registers the legacy query schema by default", () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    registerSessionSearchTool(mockPi, {} as any);

    const schema = JSON.stringify(captured.parameters);
    assert.strictEqual(captured.name, "session_search");
    assert.match(schema, /query/);
    assert.doesNotMatch(schema, /markdown/);
    assert.match(schema, /"minimum":1/);
    assert.match(schema, /"maximum":20/);
    const guidelines = captured.promptGuidelines.join("\n");
    assert.match(guidelines, /specific fact required for the next step/);
    assert.match(guidelines, /evicted part of the current session or another past session/);
    assert.match(guidelines, /Do not guess, repeat completed work/);
    assert.match(guidelines, /Use session_get when exact canonical source context/);
  });

  for (const variant of ['legacy', 'structured', 'anchors'] as const) {
    it(`${variant} flags empty and whitespace input as native errors`, async () => {
      let captured: any;
      registerSessionSearchTool({ registerTool: (def: any) => { captured = def; } } as any, {} as any, { variant });
      for (const value of ['', '   ']) {
        const result = await captured.execute('invalid-input', variant === 'anchors' ? { markdown: value } : { query: value });
        assert.equal(result.details.success, false);
        assert.equal(result.isError, true);
        assert.match(result.details.message, /is required/);
      }
    });
  }

  for (const variant of ['legacy', 'structured'] as const) {
    it(`${variant} guidance names only include options present in its public schema`, () => {
      let captured: any;
      registerSessionSearchTool({ registerTool: (def: any) => { captured = def; } } as any, {} as any, { variant });
      const names = [...new Set<string>(captured.promptGuidelines.join('\n').match(/\binclude(?:_[a-z_]+|[A-Z]\w*)\b/g) ?? [])];
      assert.equal(names.length, 3);
      for (const name of names) assert.ok(name in captured.parameters.properties, `Unavailable public option: ${name}`);
    });
    for (const flag of ['include_current_session', 'include_tool_output', 'include_service'] as const) {
      it(`${variant} honors its public ${flag} opt-in`, async () => {
        const sessionsDir = makeSessionsDir();
        const id = 'public-optin-session';
        const role = flag === 'include_tool_output' ? 'toolResult' : 'user';
        const rows: any[] = [{ type: 'session', id, cwd: '/work/probe', timestamp: '2026-07-11T00:00:00.000Z' }];
        if (flag === 'include_service') rows.push({ type: 'session_info', id: 'info', name: 'service optin probe', timestamp: '2026-07-11T00:00:30.000Z' });
        rows.push({ type: 'message', id: 'optin-entry', timestamp: '2026-07-11T00:01:00.000Z', message: { role, content: 'public optin needle' } });
        fs.writeFileSync(path.join(sessionsDir, 'source.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        const db = new DatabaseManager(path.join(sessionsDir, 'db'));
        try {
          indexAllSessions(db, sessionsDir);
          let captured: any;
          registerSessionSearchTool({ registerTool: (def: any) => { captured = def; } } as any, db, { variant }, { sessionsDir, currentSessionId: flag === 'include_current_session' ? id : undefined });
          const ordinary = await captured.execute('ordinary-optin', { query: 'public optin needle' });
          assert.equal(ordinary.details.success, true);
          assert.equal(ordinary.details.count, 0);
          const explicit = await captured.execute('explicit-optin', { query: 'public optin needle', [flag]: true });
          assert.equal(explicit.details.success, true);
          assert.equal(explicit.details.count, 1);
          assert.match(explicit.content[0].text, /optin-entry/);
        } finally { db.close(); }
      });
    }
  }

  for (const variant of ['legacy', 'structured'] as const) {
    it(`${variant} rejects explicit blank session IDs without widening the search`, async () => {
      const sessionsDir = makeSessionsDir();
      for (const id of ['one', 'two']) {
        fs.writeFileSync(path.join(sessionsDir, `${id}.jsonl`), [
          JSON.stringify({ type: 'session', id, cwd: '/work/project', timestamp: '2026-07-11T00:00:00.000Z' }),
          JSON.stringify({ type: 'message', id: `${id}-entry`, timestamp: '2026-07-11T00:01:00.000Z', message: { role: 'user', content: 'filter needle' } }),
        ].join('\n') + '\n');
      }
      const db = new DatabaseManager(path.join(sessionsDir, 'db'));
      try {
        indexAllSessions(db, sessionsDir);
        let captured: any;
        registerSessionSearchTool({ registerTool: (def: any) => { captured = def; } } as any, db, { variant }, { sessionsDir });
        for (const session_id of ['', '   ', '\t\n']) {
          const result = await captured.execute('invalid-filter', { query: 'needle', session_id });
          assert.equal(result.details.success, false);
          assert.equal(result.details.error, 'invalid_session_id');
          assert.equal(result.isError, true);
          assert.match(result.details.message, /omit|non-empty/);
        }
        const ordinary = await captured.execute('omitted-filter', { query: 'needle' });
        assert.equal(ordinary.details.success, true);
        assert.equal(ordinary.details.count, 2);
        const exact = await captured.execute('exact-filter', { query: 'needle', session_id: 'one' });
        assert.equal(exact.details.count, 1);
        assert.match(exact.content[0].text, /one-entry/);
        assert.doesNotMatch(exact.content[0].text, /two-entry/);
        const schema = captured.parameters.properties.session_id;
        assert.equal(schema.minLength, 1);
        assert.equal(new RegExp(schema.pattern).test('   '), false);
      } finally { db.close(); }
    });
  }

  it('keeps ordinary legacy search conversational and exposes current/tool records only by opt-in', async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const sessionsDir = makeSessionsDir();
    const databaseDir = path.join(ROOT_DIR, 'db');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const write = (file: string, id: string, entries: unknown[]) => fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', id, timestamp: '2026-07-11T00:00:00.000Z', cwd: '/work/project' }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join('\n') + '\n');
    write(path.join(sessionsDir, 'old.jsonl'), 'old-session', [
      { type: 'message', id: 'old-user', parentId: null, timestamp: '2026-07-11T00:01:00.000Z', message: { role: 'user', content: 'primary needle' } },
      { type: 'message', id: 'old-tool', parentId: 'old-user', timestamp: '2026-07-11T00:02:00.000Z', message: { role: 'toolResult', content: [{ type: 'tool_result', content: 'tool needle' }] } },
    ]);
    write(path.join(sessionsDir, 'current.jsonl'), 'current-session', [
      { type: 'message', id: 'current-user', parentId: null, timestamp: '2026-07-11T00:03:00.000Z', message: { role: 'user', content: 'current needle' } },
    ]);
    const dbManager = new DatabaseManager(databaseDir);
    try {
      indexAllSessions(dbManager, sessionsDir);
      registerSessionSearchTool(mockPi, dbManager, { variant: 'legacy' }, { sessionsDir, currentSessionId: 'current-session' });
      const ordinary = await captured.execute('ordinary', { query: 'needle', limit: 20 });
      assert.equal(ordinary.details.count, 1);
      assert.match(ordinary.content[0].text, /primary needle/);
      assert.doesNotMatch(ordinary.content[0].text, /tool needle|current needle/);
      const explicit = await captured.execute('explicit', { query: 'needle', limit: 20, include_current_session: true, include_tool_output: true });
      assert.equal(explicit.details.count, 3);
      assert.match(explicit.content[0].text, /tool needle/);
      assert.match(explicit.content[0].text, /current needle/);
    } finally { dbManager.close(); }
  });

  it("enforces the configured sessions root for legacy and structured runtime searches", async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const databaseDir = makeSessionsDir();
    const sessionsDir = path.join(ROOT_DIR, "configured-root");
    const outsideDir = path.join(ROOT_DIR, "outside-root");
    const deletedDir = path.join(sessionsDir, "deleted-project");
    fs.mkdirSync(path.join(outsideDir, "outside-project"), { recursive: true });
    fs.mkdirSync(deletedDir, { recursive: true });
    const writeSession = (filePath: string, id: string, text: string) => fs.writeFileSync(filePath, [
      JSON.stringify({ type: "session", id, timestamp: "2026-07-11T00:00:00.000Z", cwd: "/work/project" }),
      JSON.stringify({ type: "message", id: `${id}-message`, parentId: null, timestamp: "2026-07-11T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text }] } }),
    ].join("\n"));
    writeSession(path.join(outsideDir, "outside-project", "outside.jsonl"), "outside-session", "outside-secret");
    writeSession(path.join(deletedDir, "deleted.jsonl"), "deleted-session", "deleted-secret");
    const dbManager = new DatabaseManager(databaseDir);
    try {
      indexAllSessions(dbManager, outsideDir);
      indexAllSessions(dbManager, sessionsDir);
      fs.rmSync(path.join(deletedDir, "deleted.jsonl"));

      registerSessionSearchTool(mockPi, dbManager, { variant: "legacy" }, { sessionsDir });
      const legacy = await captured.execute("legacy", { query: "secret", limit: 20 });
      assert.equal(legacy.details.count, 0);

      registerSessionSearchTool(mockPi, dbManager, { variant: "structured" }, { sessionsDir });
      const structured = await captured.execute("structured", { query: "secret", limit: 20 });
      assert.equal(structured.details.count, 0);
    } finally {
      dbManager.close();
    }
  });

  it('publishes canonical IDs in the default legacy output when JSONL ownership is available', async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const databaseDir = makeSessionsDir();
    const sessionsDir = path.join(ROOT_DIR, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, 'canonical.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'legacy-canonical-session', timestamp: '2026-07-11T00:00:00.000Z', cwd: '/work/project' }),
      JSON.stringify({ type: 'message', id: 'legacy-canonical-entry', parentId: null, timestamp: '2026-07-11T00:01:00.000Z', message: { role: 'user', content: 'legacy canonical needle' } }),
    ].join('\n') + '\n');
    const dbManager = new DatabaseManager(databaseDir);
    try {
      indexAllSessions(dbManager, sessionsDir);
      registerSessionSearchTool(mockPi, dbManager, { variant: 'legacy' }, { sessionsDir });
      const result = await captured.execute('legacy-canonical', { query: 'needle', limit: 1 });
      assert.equal(result.details.count, 1);
      assert.match(result.content[0].text, /session_id=legacy-canonical-session/);
      assert.match(result.content[0].text, /entry_id=legacy-canonical-entry/);
    } finally {
      dbManager.close();
    }
  });

  it("clamps negative and fractional legacy limits before querying", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "bounded-limit-session",
        project: "bounded-project",
        cwd: "/work/bounded",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: Array.from({ length: 25 }, (_, index) => ({
          id: `bounded-limit-message-${index}`,
          role: "assistant",
          content: `bounded-limit-needle ${index}`,
          timestamp: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
        })),
      });
      registerSessionSearchTool(mockPi, dbManager);

      const negative = await captured.execute("tc-negative-limit", {
        query: "bounded-limit-needle",
        limit: -1,
      });
      const fractional = await captured.execute("tc-fractional-limit", {
        query: "bounded-limit-needle",
        limit: 2.9,
      });

      assert.strictEqual(negative.details.count, 1);
      assert.strictEqual(fractional.details.count, 2);
      assert.ok(negative.content[0].text.length < 2_000);
      assert.ok(fractional.content[0].text.length < 4_000);
    } finally {
      dbManager.close();
    }
  });

  it("clamps non-finite snippetChars values instead of propagating NaN", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "nan-snippet-session",
        project: "nan-snippet-project",
        cwd: "/work/nan-snippet",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "nan-snippet-message",
          role: "assistant",
          content: `needle ${"a".repeat(500)}`,
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);

      const nanResult = await captured.execute("tc-nan-snippet", {
        query: "needle",
        snippetChars: NaN,
      });
      const infinityResult = await captured.execute("tc-infinity-snippet", {
        query: "needle",
        snippetChars: Infinity,
      });
      const largeResult = await captured.execute("tc-large-snippet", {
        query: "needle",
        snippetChars: 999_999_999,
      });

      assert.strictEqual(nanResult.details.snippetChars, 1_200);
      assert.strictEqual(infinityResult.details.snippetChars, 1_200);
      assert.strictEqual(largeResult.details.snippetChars, 4_000);
      assert.ok(Number.isFinite(nanResult.details.snippetChars));
      assert.match(nanResult.content[0].text, /needle a+/);
    } finally {
      dbManager.close();
    }
  });

  it("bounds oversized legacy results and reports truncation without duplicating output in details", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);
    const oversizedContent = `needle ${"x".repeat(6_000_000)}`;

    try {
      // Seed a pre-cap database row directly. New ingestion paths must cap
      // message content, but search output still needs to stay bounded for
      // oversized rows written by older extension versions.
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "oversized-session",
        "oversized-project",
        "/work/oversized",
        "2026-07-11T00:00:00.000Z",
        null,
        1,
      );
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        "oversized-message",
        "oversized-session",
        "assistant",
        oversizedContent,
        "2026-07-11T00:01:00.000Z",
      );
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-oversized", { query: "needle" });
      const output = result.content[0].text as string;

      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.match(output, /truncated/);
      assert.match(output, /6000007 chars total/);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.strictEqual(result.details.outputChars, output.length);
      assert.strictEqual(result.details.output, undefined);
      assert.ok(JSON.stringify(result.details).length < 1_000);
    } finally {
      dbManager.close();
    }
  });

  it("offers a bounded snippetChars override for legacy searches", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "bounded-override-session",
        project: "bounded-project",
        cwd: "/work/bounded",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "bounded-override-message",
          role: "assistant",
          content: `needle ${"y".repeat(10_000)}`,
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);

      assert.match(JSON.stringify(captured.parameters), /snippetChars/);
      const result = await captured.execute("tc-bounded-override", {
        query: "needle",
        snippetChars: 2_000,
      });

      assert.strictEqual(result.details.snippetChars, 2_000);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.match(result.content[0].text, /10007 chars total/);
      assert.ok(result.content[0].text.length < 3_000);
    } finally {
      dbManager.close();
    }
  });

  it("enforces a hard 50 KiB ceiling across many large legacy results", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "aggregate-ceiling-session",
        project: "aggregate-project",
        cwd: "/work/aggregate",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: Array.from({ length: 20 }, (_, index) => ({
          id: `aggregate-message-${index}`,
          role: "assistant",
          content: `needle-${index} ${"z".repeat(10_000)}`,
          timestamp: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
        })),
      });
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-aggregate-ceiling", {
        query: "needle",
        limit: 20,
        snippetChars: 4_000,
      });
      const output = result.content[0].text as string;

      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.strictEqual(result.details.outputTruncated, true);
      assert.match(output, /output truncated/);
      assert.match(output, /refine the query or lower the result limit/);
    } finally {
      dbManager.close();
    }
  });

  it("bounds the zero-result response without echoing an oversized query", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "zero-result-session",
        project: "zero-result-project",
        cwd: "/work/zero-result",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "zero-result-message",
          role: "assistant",
          content: "indexed haystack",
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);
      const query = `${" ".repeat(60_000)}missing`;

      const result = await captured.execute("tc-zero-result", { query });
      const output = result.content[0].text as string;

      assert.strictEqual(result.details.count, 0);
      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.strictEqual(output.includes(query), false);
      assert.ok(JSON.stringify(result.details).length < 1_000);
    } finally {
      dbManager.close();
    }
  });

  it("registers structured evidence with explicit opt-ins and consistent bounded count", async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);
    const file = path.join(memoryDir, "structured.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "session", id: "structured-session", cwd: "/work/structured", timestamp: "2026-07-11T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "structured-entry", timestamp: "2026-07-11T00:01:00.000Z", message: { role: "user", content: "structured 😀 needle" } }),
    ].join("\n") + "\n");
    try {
      registerSessionSearchTool(mockPi, dbManager, { variant: "structured" }, { currentSessionId: "structured-session" });
      assert.match(JSON.stringify(captured.parameters), /include_current_session/);
      assert.match(JSON.stringify(captured.parameters), /session_id/);
      const guidelines = captured.promptGuidelines.join("\n");
      assert.match(guidelines, /specific fact required for the next step/);
      assert.match(guidelines, /evicted part of the current session or another past session/);
      assert.match(guidelines, /Do not guess, repeat completed work/);
      assert.match(guidelines, /Use session_get when exact canonical source context/);
      const result = await captured.execute("structured", { query: "needle", limit: 1 });
      const output = result.content[0].text as string;
      const rows = output === "No results found." ? [] : output.split("\n").map((line: string) => JSON.parse(line));
      assert.strictEqual(result.details.count, rows.length);
      assert.strictEqual(rows.length, 0);
      assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);

      indexSession(dbManager, { id: "structured-session", project: "structured", cwd: "/work/structured", startedAt: "2026-07-11T00:00:00.000Z", endedAt: null, messages: [{ id: "structured-entry", role: "user", content: "structured 😀 needle", timestamp: "2026-07-11T00:01:00.000Z" }] });
      dbManager.getDb().prepare("INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)").run(file, "structured-session", fs.statSync(file).size, fs.statSync(file).mtimeMs, new Date().toISOString());
      const excluded = await captured.execute("structured-excluded", { query: "needle", limit: 1 });
      assert.strictEqual(excluded.details.count, 0);
      const found = await captured.execute("structured-found", { query: "needle", limit: 1, include_current_session: true });
      const foundRows = found.content[0].text.split("\n").map((line: string) => JSON.parse(line));
      assert.strictEqual(found.details.count, foundRows.length);
      assert.strictEqual(foundRows[0].session_id, "structured-session");
      assert.strictEqual(foundRows[0].entry_id, "structured-entry");
      assert.strictEqual(foundRows[0].anchor, "pi://session/structured-session#entry=structured-entry");
    } finally {
      dbManager.close();
    }
  });

  it("bounds ambiguous prefix text and details without echoing the query", async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);
    const shared = `ambiguous-${"a".repeat(30_000)}`;
    try {
      for (const suffix of ["-one", "-two"]) {
        indexSession(dbManager, {
          id: `${shared}${suffix}`, project: "ambiguous", cwd: "/work/ambiguous", startedAt: "2026-07-11T00:00:00.000Z", endedAt: null,
          messages: [{ id: `${suffix}-entry`, role: "user", content: "needle", timestamp: "2026-07-11T00:01:00.000Z" }],
        });
      }
      registerSessionSearchTool(mockPi, dbManager, { variant: "structured" });
      const query = "needle";
      const result = await captured.execute("ambiguous", { query, session_id: shared });
      const output = result.content[0].text as string;
      assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") <= 50 * 1024);
      assert.strictEqual(result.details.count, result.details.candidates.length);
      assert.equal(result.details.success, false);
      assert.equal(result.isError, true);
      assert.strictEqual(output.includes(query), false);
    } finally {
      dbManager.close();
    }
  });

  it("registers and executes the anchor markdown-only schema when configured", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const sessionsDir = makeSessionsDir();
    const filePath = path.join(sessionsDir, "session.jsonl");
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: "message",
      timestamp: "2026-05-15T10:00:00.000Z",
      sessionId: "session-1",
      cwd: "/work/project",
      message: { role: "user", content: "needle" },
    })}\n`);

    registerSessionSearchTool(mockPi, {} as any, { variant: "anchors" }, { sessionsDir });

    const schema = JSON.stringify(captured.parameters);
    assert.strictEqual(captured.name, "session_search");
    assert.match(schema, /markdown/);
    assert.doesNotMatch(schema, /query/);
    assert.match(captured.description, /all terms must match/);
    assert.match(captured.description, /any requires at least one listed term/);
    assert.match(captured.description, /exclude removes matching ranges/);
    assert.match(captured.description, /Output is plain text: count, optional message/);
    assert.match(captured.description, /path:startLine-endLine with a short reason/);
    assert.match(captured.description, /Example:\nfrom: 2026-05-14/);
    assert.match(captured.promptGuidelines.join("\n"), /Use all for required terms/);
    assert.match(captured.promptGuidelines.join("\n"), /specific fact required for the next step/);
    assert.match(captured.promptGuidelines.join("\n"), /evicted part of the current session or another past session/);
    assert.match(captured.promptGuidelines.join("\n"), /Do not guess, repeat completed work/);

    const empty = await captured.execute("tc-1", { markdown: "" });
    assert.strictEqual(empty.details.success, false);
    assert.strictEqual(empty.details.message, "markdown is required");

    const result = await captured.execute("tc-2", { markdown: "any:\n- needle" });
    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.deepStrictEqual(result.details.ranges.map((range: any) => ({
      path: range.path,
      startLine: range.startLine,
      endLine: range.endLine,
      reason: range.reason,
    })), [{ path: filePath, startLine: 1, endLine: 1, reason: "matched any: needle" }]);
    assert.strictEqual(result.details.output, result.content[0].text);
    assert.match(result.content[0].text, /^count: 1\nanchors:\n-/);
    assert.match(result.content[0].text, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1-1 — matched any: needle`));
    assert.doesNotMatch(result.content[0].text, /"ranges"/);
    assert.doesNotMatch(result.content[0].text, /"startLine"/);
    assert.doesNotMatch(result.content[0].text, /"sessionId"/);
  });
  it('preserves native failure flags from legacy and anchor workers', async () => {
    const sessionsDir = makeSessionsDir();
    const db = new DatabaseManager(path.join(sessionsDir, 'db'));
    try {
      let captured: any;
      const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
      registerSessionSearchTool(mockPi, db, { variant: 'legacy' }, { sessionsDir });
      const emptyIndex = await captured.execute('empty-index', { query: 'needle' });
      assert.equal(emptyIndex.details.success, false);
      assert.equal(emptyIndex.isError, true);
      registerSessionSearchTool(mockPi, db, { variant: 'anchors' }, { sessionsDir });
      const invalidAnchor = await captured.execute('invalid-anchor', { markdown: 'from: not-a-date\nany:\n- needle' });
      assert.equal(invalidAnchor.details.success, false);
      assert.equal(invalidAnchor.isError, true);
    } finally { db.close(); }
  });
});
