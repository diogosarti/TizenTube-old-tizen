'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { sanitize, Writer, cleanProfile } = require('../record-diagnostics');

test('CPU profile retains stacks and timings without source text, URL queries or local paths', () => {
    const result = cleanProfile({ head: { functionName: 'handleMedia', url: 'https://example.test/player.js?token=private',
        selfTime: 12, totalTime: 20, children: [{ functionName: 'copyBytes', url: 'file:///private/source.js', selfTime: 8 }] },
        samples: [1, 2], timestamps: [10, 20], source: 'private script source' });
    assert.equal(result.nodes[0].source, 'player.js');
    assert.deepEqual(result.nodes[0].children, [2]);
    assert.equal(result.nodes[1].selfTime, 8);
    assert.deepEqual(result.samples, [1, 2]);
    assert.doesNotMatch(JSON.stringify(result), /private|example\.test|file:/);
    const local = cleanProfile({ head: { functionName: 'copy', url: 'file:///private/widget/compat.js', numberOfCalls: 3 } });
    assert.equal(local.nodes[0].source, 'compat.js');
    assert.equal(local.nodes[0].numberOfCalls, 3);
    assert.doesNotMatch(JSON.stringify(local), /private|file:/);
});

test('recorder exports only bounded public CDN journal metadata', () => {
    const cdns=Array.from({length:60},(_,i)=>({host:'rr'+i+'---sn-example.googlevideo.com',mode:'1.3',reason:'tls',count:2,firstAt:100,lastAt:200,handledAt:0,
        token:'private-synthetic',url:'https://example.test/private-synthetic'}));
    const result=sanitize({logs:[],cdns});
    assert.equal(result.cdns.length,50);
    assert.equal(result.cdns[0].host,cdns[0].host);
    assert.equal(JSON.stringify(result).includes('private-synthetic'),false);
    assert.deepEqual(sanitize({logs:[],cdns:[{host:'evil.test',mode:'1.3',reason:'tls'}]}).cdns,[]);
});

test('recorder keeps playback diagnostics without arbitrary player or account fields', () => {
    const result = sanitize({ app: true, video: { time: 12, rate: 1, buffered: [[0, 20]], cookie: 'private' },
        logs: [{ n: 1, code: 'tls.request-error', detail: 'https://example.test/v?token=secret' },
            { n: 2, code: 'page.error', detail: 'private account message' }],
        stats: { lvb: '0.0-20.0', fmt: '299', docid: 'private', lab: 'https://example.test/private' },
        native: [{ id: 9, rid: 7, itag: 140, kind: 'audio', host: 'rr1---synthetic.googlevideo.com', endpoint: 'videoplayback',
            phase: 'headers', phaseMs: 1234, wireReceived: 1024, readCompletions: 2, cookie: 'private', url: 'https://example.test/private' }],
        tls: { video: 'TLS 1.3', bytes: 4096, cookie: 'private' }, account: 'private',
        memory:{pendingBytes:4096,pendingRequests:2,assemblyPeakBytes:8192,cookie:'private'} });
    assert.equal(result.video.time, 12);
    assert.deepEqual(result.memory,{pendingBytes:4096,pendingRequests:2,assemblyPeakBytes:8192});
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
            ws.send(JSON.stringify({ id: request.id, result: { result: { value: JSON.stringify({ app: true, epoch: 1, logs: [], video: { time: evaluations, rate: 1 },
                cdns: [{host:'rr1---sn-example.googlevideo.com',mode:'1.3',reason:'tls',count:evaluations<3?2:3,firstAt:100,lastAt:200,handledAt:0}] }) } } }));
            if (connections === 1) setTimeout(() => ws.terminate(), 50);
        });
    });
    let child;
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(7011, '127.0.0.1', resolve); });
        child = spawn(process.execPath, [path.join(__dirname, '..', 'record-diagnostics.js'), '127.0.0.1', dir], { stdio: 'ignore' });
        const deadline = Date.now() + 11000;
        while (Date.now() < deadline && (connections < 2 || evaluations < 4)) await new Promise(r => setTimeout(r, 100));
        assert.ok(connections >= 2);
        const records = fs.readdirSync(dir).flatMap(n => fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n').map(JSON.parse));
        assert.ok(records.some(r => r.type === 'sample'));
        assert.ok(records.some(r => r.state && r.state.startsWith('disconnected;')));
        const journals=records.filter(r=>r.type==='cdn-journal');
        assert.deepEqual(journals.map(r=>r.entries[0].count),[2,3], 'Export changes once, without repeating unchanged lists on reconnect/poll');
    } finally {
        if (child) { const ended = new Promise(r => child.once('exit', r)); child.kill(); await ended; }
        for (const client of wss.clients) client.terminate();
        await new Promise(r => wss.close(r));
        await new Promise(r => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('recorder captures an explicit short CPU profile on its existing inspector connection', { timeout: 25000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recorder-profile-'));
    fs.writeFileSync(path.join(dir, 'cpu-profile.request'), '');
    const server = http.createServer((req, res) => res.end(JSON.stringify([{ id: 1 }])));
    const wss = new WebSocketServer({ server });
    let connections = 0, starts = 0, stops = 0, evaluations = 0;
    wss.on('connection', ws => {
        connections++;
        ws.on('message', data => {
            const req = JSON.parse(data);
            let result = {};
            if (req.method === 'Runtime.evaluate') {
                evaluations++;
                result = { result: { value: JSON.stringify({ app: true, epoch: 1, logs: [] }) } };
            } else if (req.method === 'Profiler.start') starts++;
            else if (req.method === 'Profiler.stop') { stops++; }
            else if (req.method === 'Profiler.getProfileHeaders') result = { headers: [{ uid: 7 }] };
            else if (req.method === 'Profiler.getCPUProfile') {
                assert.equal(req.params.uid, 7);
                result = { profile: { head: { functionName: 'mediaLoad', selfTime: 5, children: [] } } };
            } else assert.equal(req.method, 'Profiler.enable');
            ws.send(JSON.stringify({ id: req.id, result }));
        });
    });
    let child;
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(7011, '127.0.0.1', resolve); });
        child = spawn(process.execPath, [path.join(__dirname, '..', 'record-diagnostics.js'), '127.0.0.1', dir], { stdio: 'ignore' });
        const deadline = Date.now() + 21000;
        while (Date.now() < deadline && !fs.readdirSync(dir).some(n => n.startsWith('ttcpu-'))) await new Promise(r => setTimeout(r, 100));
        const file = fs.readdirSync(dir).find(n => n.startsWith('ttcpu-'));
        assert.ok(file, 'Saved profile from legacy header/getCPUProfile protocol');
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).nodes[0].name, 'mediaLoad');
        assert.equal(connections, 1);
        assert.equal(starts, 1);
        assert.equal(stops, 1);
        assert.ok(evaluations > 2, 'Ordinary sampling continues during profiling');
        assert.equal(fs.existsSync(path.join(dir, 'cpu-profile.request')), false);
    } finally {
        if (child) { const ended = new Promise(r => child.once('exit', r)); child.kill(); await ended; }
        for (const client of wss.clients) client.terminate();
        await new Promise(r => wss.close(r));
        await new Promise(r => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
