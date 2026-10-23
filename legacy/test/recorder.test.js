'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { sanitize, Writer } = require('../record-diagnostics');

test('recorder keeps playback diagnostics without arbitrary player or account fields', () => {
    const result = sanitize({ app: true, video: { time: 12, rate: 1, buffered: [[0, 20]], cookie: 'private' },
        logs: [{ n: 1, code: 'tls.request-error', detail: 'https://example.test/v?token=secret' },
            { n: 2, code: 'page.error', detail: 'private account message' }],
        stats: { lvb: '0.0-20.0', fmt: '299', docid: 'private', lab: 'https://example.test/private' },
        native: [{ id: 9, rid: 7, itag: 140, kind: 'audio', host: 'rr1---synthetic.googlevideo.com', endpoint: 'videoplayback',
            phase: 'headers', phaseMs: 1234, wireReceived: 1024, readCompletions: 2, cookie: 'private', url: 'https://example.test/private' }],
        tls: { video: 'TLS 1.3', bytes: 4096, cookie: 'private' }, account: 'private' });
    assert.equal(result.video.time, 12);
    assert.deepEqual(result.video.buffered, [[0, 20]]);
    assert.equal(result.stats.lvb, '0.0-20.0');
    assert.equal(result.tls.video, 'TLS 1.3');
    assert.equal(result.native[0].rid, 7);
    assert.equal(result.native[0].kind, 'audio');
    assert.equal(result.native[0].phase, 'headers');
    assert.equal(result.native[0].phaseMs, 1234);
    assert.equal(result.native[0].host, 'rr1---synthetic.googlevideo.com');
    assert.doesNotMatch(JSON.stringify(result), /private|example\.test|secret/);
});

test('recorder rotates its own files and preserves unrelated files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recorder-'));
    try {
        fs.writeFileSync(path.join(dir, 'existing.txt'), 'preserve');
        const writer = new Writer(dir, 120, 3);
        for (let n = 0; n < 10; n++) writer.write({ type: 'sample', n, bytes: 12345 });
        const logs = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'));
        assert.equal(logs.length, 3);
        assert.equal(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8'), 'preserve');
        const records = logs.flatMap(n => fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n').map(JSON.parse));
        assert.ok(records.some(r => r.n === 9));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recorder reconnects after a dropped inspector connection without launching the app', { timeout: 15000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recorder-reconnect-'));
    const server = http.createServer((req, res) => {
        assert.equal(req.url, '/pagelist.json');
        res.end(JSON.stringify([{ id: 1 }]));
    });
    const wss = new WebSocketServer({ server });
    let connections = 0, evaluations = 0;
    wss.on('connection', ws => {
        connections++;
        ws.on('message', data => {
            const request = JSON.parse(data);
            assert.equal(request.method, 'Runtime.evaluate');
            evaluations++;
            ws.send(JSON.stringify({ id: request.id, result: { result: { value: JSON.stringify({ app: true, epoch: 1, logs: [], video: { time: evaluations, rate: 1 } }) } } }));
            if (connections === 1) setTimeout(() => ws.terminate(), 50);
        });
    });
    let child;
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(7011, '127.0.0.1', resolve); });
        child = spawn(process.execPath, [path.join(__dirname, '..', 'record-diagnostics.js'), '127.0.0.1', dir], { stdio: 'ignore' });
        const deadline = Date.now() + 11000;
        while (Date.now() < deadline && (connections < 2 || evaluations < 2)) await new Promise(r => setTimeout(r, 100));
        assert.ok(connections >= 2);
        const records = fs.readdirSync(dir).flatMap(n => fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n').map(JSON.parse));
        assert.ok(records.some(r => r.type === 'sample'));
        assert.ok(records.some(r => r.state && r.state.startsWith('disconnected;')));
    } finally {
        if (child) { const ended = new Promise(r => child.once('exit', r)); child.kill(); await ended; }
        for (const client of wss.clients) client.terminate();
        await new Promise(r => wss.close(r));
        await new Promise(r => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
