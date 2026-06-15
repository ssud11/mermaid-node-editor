// MCP contract tests (QA-2) — BLACK BOX against the real bundled artifact.
//
// Spawns `dist/server.js` and speaks newline-delimited JSON-RPC over real stdio,
// so it validates the shipped npm package end to end (boot, the tool schemas,
// happy-path + error responses, stdio framing) — not just the pure handlers.
// Deliberately imports NO MCP SDK, keeping this test build light (the SDK's type
// graph OOMs tsc under node10 resolution).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SERVER = join(process.cwd(), 'dist', 'server.js');

/** Spawn the server, send all messages on stdin, return id→response map. */
function converse(messages: unknown[]): Promise<Map<number, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const map = new Map<number, any>();
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (msg.id !== undefined && msg.id !== null) map.set(msg.id, msg);
        } catch {
          /* a non-JSON line on stdout is itself a framing bug — caught by the hygiene test */
        }
      }
      resolve(map);
    });
    const kill = setTimeout(() => child.kill(), 8000);
    kill.unref();
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end();
  });
}

const FLOW = 'graph TD\nA[Start] -->|yes| B{Check}\nsubgraph S [Phase]\nD[Inside]\nend';
let res: Map<number, any>;

before(async () => {
  // Ensure the bundle is current (CI runs `npm test`, not `npm run build`).
  execSync('node esbuild.config.js', { cwd: process.cwd(), stdio: 'ignore' });
  res = await converse([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flow_extract', arguments: { text: FLOW } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'flow_rename', arguments: { text: 'graph TD\nA --> B', oldId: 'A', newId: 'Z' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'flow_rename', arguments: { text: 'graph TD\nA --> B', oldId: 'A', newId: 'B' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'flow_extract', arguments: {} } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'flow_extract', arguments: { text: 'sequenceDiagram\nAlice->>Bob: hi' } } },
  ]);
});

const callJson = (id: number) => JSON.parse(res.get(id).result.content[0].text);

test('contract: server initializes over stdio', () => {
  assert.equal(res.get(1).result.serverInfo.name, 'mermaid-node-editor-flows');
});

test('contract: tools/list exposes the 6 flow tools, each with an object input schema', () => {
  const tools = res.get(2).result.tools;
  assert.deepEqual(
    tools.map((t: any) => t.name).sort(),
    ['flow_extract', 'flow_overview', 'flow_query', 'flow_relabel', 'flow_rename', 'flow_validate']
  );
  for (const t of tools) assert.equal(t.inputSchema.type, 'object', `${t.name} input schema`);
});

test('contract: flow_extract returns typed JSON over real stdio (golden shape)', () => {
  const data = callJson(3);
  const b = data.blocks[0];
  assert.deepEqual(Object.keys(data).sort(), ['blockCount', 'blocks']);
  assert.equal(b.supported, true);
  assert.deepEqual(b.nodes.find((n: any) => n.id === 'A'), { id: 'A', label: 'Start', shape: 'rectangle', line: 1 });
  assert.equal(b.nodes.find((n: any) => n.id === 'B').shape, 'diamond');
  assert.deepEqual(b.subgraphs[0], { id: 'S', title: 'Phase', members: ['D'] });
  const e = b.edges[0];
  assert.deepEqual([e.from, e.to, e.label, e.kind.stroke], ['A', 'B', 'yes', 'solid']);
});

test('contract: flow_rename propagates + returns edited text; a collision is a clean error', () => {
  const ok = callJson(4);
  assert.equal(ok.ok, true);
  assert.match(ok.newText, /Z --> B/);
  const collide = callJson(5);
  assert.equal(collide.ok, false);
  assert.match(collide.error, /already exists/);
});

test('contract: a call with neither text nor path returns an isError result, not a crash', () => {
  const r = res.get(6).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /text.*or.*path/i);
});

test('contract: an unsupported diagram → supported:false over the wire (no error)', () => {
  assert.notEqual(res.get(7).result.isError, true);
  assert.equal(callJson(7).blocks[0].supported, false);
});

test('stdio hygiene: no src file writes to stdout (stdout is the JSON-RPC channel)', () => {
  const dir = join(process.cwd(), 'src');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/console\.log\(/.test(src), `${f}: must not console.log (corrupts stdio framing)`);
    assert.ok(!/process\.stdout/.test(src), `${f}: must not write process.stdout`);
  }
});
