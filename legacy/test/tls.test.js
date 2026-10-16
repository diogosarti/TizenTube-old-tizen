'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Logger = require('../web/logger');

function setup(mode = 'auto', options = {}) {
    const listeners = {}, sent = [], timers = new Set();
    const container = { addEventListener(type, callback) { listeners[type] = callback; }, appendChild() {} };
    const win = { ArrayBuffer, Uint8Array: options.Uint8Array || Uint8Array, navigator: { userAgent: 'Synthetic test' },
        localStorage: { getItem: () => JSON.stringify({ tlsMode: mode }) }, addEventListener() {},
        document: { createElement(type) {
            if (type === 'embed') return { postMessage: value => sent.push(value) };
            let url;
            return { set href(value) { url = new URL(value, 'https://www.youtube.com/tv'); },
                get href() { return url.href; }, get protocol() { return url.protocol; }, get host() { return url.host; },
                get hostname() { return url.hostname; }, get port() { return url.port; }, get pathname() { return url.pathname; },
                get search() { return url.search; }, get username() { return url.username; }, get password() { return url.password; } };
        } }, XMLHttpRequest: function () { throw new Error('Unexpected system fallback'); } };
    const log = Logger.create(100);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/tls-transport.js'), 'utf8'), { window: win, Date: options.Date || Date, setTimeout(callback, ms) {
        const t = setTimeout(() => { timers.delete(t); callback(); }, ms); timers.add(t); return t;
    }, clearTimeout(t) { clearTimeout(t); timers.delete(t); } });
    const transport = win.LegacyTLS.create(container, log);
    transport.install(win);
    function message(value) { listeners.message({ data: value }); }
    message({ type: 'ready', ok: true });
    return { win, transport, sent, log, message, close() { for (const t of timers) clearTimeout(t); } };
}

test('Player transport follows successful data for the current media and ignores stale and failed streams', () => {
    const env = setup('1.3');
    try {
        function start(id, mime) {
            const xhr = new env.win.XMLHttpRequest();
            xhr.open('GET', 'https://media.googlevideo.com/videoplayback?id=' + id + '&mime=' + mime);
            xhr.send(); return env.sent[env.sent.length - 1];
        }
        function response(request, tls, status, cipher = 'TLS1-3-CHACHA20-POLY1305-SHA256') {
            env.message({ type: 'tls', id: request.id, tls, cipher, verified: true });
            env.message({ type: 'headers', id: request.id, status, headers: 'Content-Length: 1\r\n' });
            env.message({ type: 'data', id: request.id, body: Uint8Array.from([1]).buffer });
        }
        const old = start('synthetic-old', 'video%2Fmp4');
        assert.equal(old.mode, '1.3');
        response(old, 'TLS 1.3', 200);
        assert.equal(env.transport.summary().video, 'TLS 1.3');
        assert.equal(env.transport.summary().videoCipher, 'TLS1-3-CHACHA20-POLY1305-SHA256');
        env.transport.setMode('1.2');
        const current = start('synthetic-current', 'video%2Fmp4');
        assert.equal(current.mode, '1.2');
        assert.equal(env.transport.summary().video, 'unknown');
        assert.equal(env.transport.summary().videoCipher, 'unknown');
        response(old, 'TLSv1.2', 200);
        assert.equal(env.transport.summary().video, 'unknown');
        response(current, 'TLSv1.3', 206);
        assert.equal(env.transport.summary().video, 'TLS 1.3');
        const audio = start('synthetic-current', 'audio%2Fmp4');
        response(audio, 'TLSv1.2', 200, 'TLS-ECDHE-ECDSA-WITH-AES-128-GCM-SHA256');
        assert.equal(env.transport.summary().audio, 'TLS 1.2');
        assert.equal(env.transport.summary().audioCipher, 'TLS-ECDHE-ECDSA-WITH-AES-128-GCM-SHA256');
        assert.equal(env.transport.summary().videoCipher, 'TLS1-3-CHACHA20-POLY1305-SHA256');
        assert.equal(env.transport.summary().video, 'TLS 1.3');
        const failed = start('synthetic-current', 'video%2Fmp4');
        response(failed, 'TLSv1.2', 403);
        assert.equal(env.transport.summary().video, 'TLS 1.3');
    } finally { env.close(); }
});

test('NaCl XHR carries POST authorization and binary media, reports negotiated TLS separately, and never falls back on a TLS error', () => {
    const env = setup('1.3');
    try {
        const xhr = new env.win.XMLHttpRequest();
        xhr.open('POST', 'https://www.youtube.com/youtubei/v1/player');
        xhr.setRequestHeader('Authorization', 'Bearer synthetic-only');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send('{"synthetic":true}');
        const request = env.sent[0];
        assert.equal(request.mode, '1.3');
        assert.match(request.headers, /authorization: Bearer synthetic-only/);
        assert.equal(Buffer.from(request.body).toString(), '{"synthetic":true}');
        env.message({ type: 'tls', id: request.id, tls: 'TLSv1.3', verified: true });
        env.message({ type: 'headers', id: request.id, status: 200, statusText: 'OK', headers: 'Content-Type: application/json\r\nSet-Cookie: synthetic-private\r\n' });
        const json = Buffer.from('{"message":"Привет"}');
        env.message({ type: 'data', id: request.id, body: json.buffer.slice(json.byteOffset, json.byteOffset + json.length) });
        env.message({ type: 'done', id: request.id });
        assert.equal(xhr.readyState, 4);
        assert.equal(JSON.parse(xhr.responseText).message, 'Привет');
        assert.equal(xhr.getResponseHeader('set-cookie'), null);

        env.transport.setMode('1.2');
        const video = new env.win.XMLHttpRequest();
        video.open('GET', 'https://media.googlevideo.com/videoplayback?synthetic=1');
        video.responseType = 'arraybuffer'; video.setRequestHeader('Range', 'bytes=0-3'); video.send();
        const media = env.sent[1];
        assert.equal(media.mode, '1.2'); assert.match(media.headers, /range: bytes=0-3/);
        env.message({ type: 'tls', id: media.id, tls: 'TLSv1.2', verified: true });
        env.message({ type: 'headers', id: media.id, status: 206, statusText: 'Partial Content', headers: 'Content-Length: 4\r\n' });
        env.message({ type: 'data', id: media.id, body: Uint8Array.from([0, 255, 128, 3]).buffer });
        env.message({ type: 'done', id: media.id });
        assert.deepEqual(Array.from(new Uint8Array(video.response)), [0, 255, 128, 3]);
        assert.equal(env.transport.summary().api, 'TLS 1.3'); assert.equal(env.transport.summary().video, 'TLS 1.2');
        assert.equal(env.transport.summary().system, 'unknown');

        let errored = false;
        const bad = new env.win.XMLHttpRequest(); bad.open('GET', 'https://invalid.example/'); bad.onerror = () => { errored = true; }; bad.send();
        env.message({ type: 'error', id: env.sent[2].id, error: 'certificate mismatch' });
        assert.equal(errored, true); assert.equal(bad.status, 0);
        assert.doesNotMatch(JSON.stringify(env.log.read()), /synthetic-only|synthetic-private/);
    } finally { env.close(); }
});

test('NaCl redirects keep forced mode, strip cross-host authorization, and an aborted/reopened XHR ignores old results', async () => {
    const env = setup();
    try {
        env.transport.setMode('1.3');
        const xhr = new env.win.XMLHttpRequest(); xhr.open('POST', 'https://www.youtube.com/redirect');
        xhr.setRequestHeader('Authorization', 'Bearer synthetic-only'); xhr.send('synthetic');
        const original = env.sent[0];
        env.message({ type: 'headers', id: original.id, status: 302, headers: 'Location: https://other.example/next\r\n' });
        env.transport.setMode('1.2');
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setTimeout(resolve, 10));
        const redirected = env.sent.find(item => item.type === 'request' && item.id !== original.id);
        assert.equal(redirected.mode, '1.3'); assert.equal(redirected.method, 'GET'); assert.equal(redirected.body.byteLength, 0);
        assert.doesNotMatch(redirected.headers, /authorization/i);
        xhr.abort(); assert.ok(env.sent.some(item => item.type === 'abort' && item.id === redirected.id));
        xhr.open('GET', 'https://www.youtube.com/new'); xhr.send();
        env.message({ type: 'done', id: redirected.id });
        assert.equal(xhr.readyState, 1);
        assert.equal(env.sent[env.sent.length - 1].mode, '1.2');

        let reader;
        env.win.Blob = class Blob {};
        env.win.FileReader = class FileReader { constructor() { reader = this; } readAsArrayBuffer() {} };
        const delayed = new env.win.XMLHttpRequest(); delayed.open('POST', 'https://www.youtube.com/old'); delayed.send(new env.win.Blob());
        delayed.abort(); delayed.open('GET', 'https://www.youtube.com/reopened'); delayed.send();
        const count = env.sent.length;
        reader.result = Uint8Array.from([1]).buffer; reader.onload();
        assert.equal(env.sent.length, count, 'An old FileReader must not submit a body into the reopened request');

        // Only a native-confirmed reset before HTTP may replay the body, with its original forced mode.
        env.transport.setMode('1.3');
        const reset = new env.win.XMLHttpRequest(); reset.open('POST', 'https://www.youtube.com/token'); reset.send('synthetic');
        let failed = 0; reset.onerror = () => { failed++; };
        const first = env.sent[env.sent.length - 1];
        env.transport.setMode('1.2');
        env.message({ type: 'error', id: first.id, error: 'TCP read: -2', retryable: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        const retry = env.sent[env.sent.length - 1];
        assert.notEqual(retry.id, first.id); assert.equal(retry.mode, '1.3');
        assert.equal(Buffer.from(retry.body).toString(), 'synthetic'); assert.equal(failed, 0);
        env.message({ type: 'error', id: retry.id, error: 'TCP read: -2', retryable: true });
        assert.equal(failed, 1, 'A second reset must finish with an error');
    } finally { env.close(); }
});

test('Media and API keep reserved slots, API precedes telemetry, and abort releases its slot', async () => {
    const historyEnv = setup();
    try {
        for (const endpoint of ['qoe', 'qoe', 'playback', 'watchtime']) {
            const xhr = new historyEnv.win.XMLHttpRequest();
            xhr.open('GET', 'https://www.youtube.com/api/stats/' + endpoint); xhr.send();
        }
        assert.deepEqual(historyEnv.sent.map(r => r.path), ['/api/stats/qoe', '/api/stats/playback', '/api/stats/watchtime'],
            'A pending telemetry request must not block history; extra telemetry stays queued');
        assert.equal(historyEnv.transport.summary().active, 3);
        assert.equal(historyEnv.transport.summary().queued, 1);
    } finally { historyEnv.close(); }

    const env = setup();
    try {
        const xhrs = [];
        function start(url) { const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', url); xhr.send(); xhrs.push(xhr); }
        for (let i = 0; i < 5; i++) start('https://www.youtube.com/youtubei/v1/browse?synthetic=' + i);
        assert.equal(env.sent.length, 4);
        start('https://www.youtube.com/api/stats/watchtime');
        start('https://media.googlevideo.com/videoplayback?id=synthetic');
        assert.equal(env.sent.length, 5, 'Media must start despite waiting API and telemetry');
        xhrs[0].abort();
        await new Promise(resolve => setTimeout(resolve, 10));
        const dispatched = env.sent.filter(r => r.type === 'request');
        assert.equal(dispatched[5].path, '/youtubei/v1/browse?synthetic=4');
        env.message({type:'done', id:dispatched[1].id});
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(env.sent.filter(r => r.type === 'request')[6].path, '/api/stats/watchtime', 'History traffic must still run');
    } finally { env.close(); }

    const mediaEnv = setup();
    try {
        function start(url) { const xhr = new mediaEnv.win.XMLHttpRequest(); xhr.open('GET', url); xhr.send(); }
        for (let i = 0; i < 6; i++) start('https://media.googlevideo.com/videoplayback?id=synthetic&part=' + i);
        assert.equal(mediaEnv.sent.length, 4, 'Media must leave two slots available for API/history');
        start('https://www.youtube.com/youtubei/v1/player');
        start('https://www.youtube.com/api/stats/watchtime');
        assert.equal(mediaEnv.sent[4].path, '/youtubei/v1/player');
        assert.equal(mediaEnv.sent[5].path, '/api/stats/watchtime');
        assert.equal(mediaEnv.transport.summary().active, 6);
        mediaEnv.message({ type: 'done', id: mediaEnv.sent[0].id });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(mediaEnv.sent[6].path, '/videoplayback?id=synthetic&part=4', 'Queued media must resume when a media slot is released');
        assert.equal(mediaEnv.transport.summary().active, 6);
        assert.equal(mediaEnv.transport.summary().queued, 1);
    } finally { mediaEnv.close(); }
});

test('Cached JSON response keeps identity and reopening discards the old response', () => {
    const env = setup();
    try {
        const xhr = new env.win.XMLHttpRequest();
        function reply(value) {
            const id = env.sent.filter(r => r.type === 'request').at(-1).id;
            const data = Buffer.from(JSON.stringify(value));
            env.message({type:'headers',id,status:200,headers:'Content-Type: application/json\r\n'});
            env.message({type:'data',id,body:data.buffer.slice(data.byteOffset,data.byteOffset+data.length)});
            env.message({type:'done',id});
        }
        xhr.open('GET','https://www.youtube.com/synthetic'); xhr.responseType = 'json'; xhr.send(); reply({message:'Привет'});
        const first = xhr.response;
        assert.equal(first.message,'Привет'); assert.equal(xhr.response,first);
        xhr.open('GET','https://www.youtube.com/synthetic2'); xhr.send(); reply({message:'second'});
        assert.equal(xhr.response.message,'second'); assert.notEqual(xhr.response,first);
    } finally { env.close(); }
});

test('XHR decodes growing UTF-8 once without prefix copies and reuses a single binary chunk', () => {
    let allocated = 0, now = 1000;
    function TrackedArray(value) { if (typeof value === 'number') allocated += value; return new Uint8Array(value); }
    const env = setup('auto', { Uint8Array: TrackedArray, Date: { now: () => now } });
    try {
        const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', 'https://www.youtube.com/synthetic'); xhr.send();
        const id = env.sent[0].id;
        env.message({ type: 'headers', id, status: 200, headers: '' });
        const decoder = new TextDecoder(); let expected = '';
        for (const chunk of [[239], [187], [191, 65, 208], [150, 240, 159], [152, 128, 255, 226, 66, 226, 130]]) {
            const body = Uint8Array.from(chunk);
            expected += decoder.decode(body, { stream: true }); now += 100;
            env.message({ type: 'data', id, body: body.buffer });
            assert.equal(xhr.responseText, expected, 'Only complete UTF-8 scalars should be visible during loading');
            assert.equal(xhr.responseText, expected);
        }
        env.message({ type: 'done', id }); expected += decoder.decode();
        assert.equal(xhr.responseText, expected, 'Truncated final UTF-8 becomes a replacement character');
        xhr.open('GET', 'https://www.youtube.com/large-text'); xhr.send();
        const next = env.sent.at(-1).id; env.message({ type: 'headers', id: next, status: 200, headers: '' });
        const block = new Uint8Array(256 * 1024).fill(65).buffer;
        for (let i = 0; i < 8; i++) {
            now += 100; env.message({ type: 'data', id: next, body: block });
            assert.equal(xhr.responseText.length, (i + 1) * block.byteLength);
        }
        env.message({ type: 'done', id: next });
        assert.equal(allocated, 0, 'Growing text must not allocate combined byte prefixes, including at DONE');
        xhr.open('GET', 'https://media.googlevideo.com/videoplayback'); xhr.responseType = 'arraybuffer'; xhr.send();
        const binary = env.sent.at(-1).id;
        env.message({ type: 'headers', id: binary, status: 200, headers: '' });
        env.message({ type: 'data', id: binary, body: block });
        assert.equal(xhr.response, null, 'Binary response remains unavailable before DONE');
        env.message({ type: 'done', id: binary });
        assert.equal(xhr.response, block, 'A single complete chunk must not be copied');
    } finally { env.close(); }
});

test('XHR repeats LOADING notifications at bounded frequency and stops old events after reentry', () => {
    let now = 1000;
    const env = setup('auto', { Date: { now: () => now } });
    try {
        const xhr = new env.win.XMLHttpRequest(), events = [];
        xhr.onreadystatechange = () => events.push('state:' + xhr.readyState);
        xhr.onprogress = e => events.push('progress:' + e.loaded);
        xhr.onload = () => events.push('load'); xhr.onloadend = () => events.push('loadend');
        xhr.open('GET', 'https://www.youtube.com/synthetic'); xhr.send();
        const id = env.sent[0].id;
        env.message({ type: 'headers', id, status: 200, headers: 'Content-Length: 33\r\n' });
        for (let i = 0; i < 32; i++) env.message({ type: 'data', id, body: Uint8Array.from([65]).buffer });
        assert.equal(events.filter(e => e.startsWith('progress')).length, 1);
        now += 100; env.message({ type: 'data', id, body: Uint8Array.from([66]).buffer });
        assert.equal(events.filter(e => e === 'state:3').length, 2);
        env.message({ type: 'done', id });
        assert.deepEqual(events.slice(-4), ['progress:33', 'state:4', 'load', 'loadend']);
        assert.equal(xhr.responseText.length, 33);

        // Reopening from LOADING must suppress the old progress and completion.
        xhr.open('GET', 'https://www.youtube.com/old'); xhr.send();
        const old = env.sent.at(-1).id;
        env.message({ type: 'headers', id: old, status: 200, headers: '' });
        xhr.onreadystatechange = () => { if (xhr.readyState === 3) { xhr.open('GET', 'https://www.youtube.com/new'); xhr.send(); } };
        events.length = 0;
        env.message({ type: 'data', id: old, body: Uint8Array.from([67]).buffer });
        env.message({ type: 'done', id: old });
        assert.equal(xhr.readyState, 1); assert.deepEqual(events, ['loadend'], 'Only the aborted request may emit loadend');

        // Reopening from the final progress must also suppress DONE/load/loadend.
        const current = env.sent.at(-1).id;
        events.length = 0;
        xhr.onreadystatechange = null;
        xhr.onprogress = () => { xhr.open('GET', 'https://www.youtube.com/final-new'); xhr.send(); };
        env.message({ type: 'headers', id: current, status: 200, headers: '' });
        env.message({ type: 'done', id: current });
        assert.equal(xhr.readyState, 1); assert.deepEqual(events, ['loadend']);
    } finally { env.close(); }
});

test('Branding stays below history and SponsorBlock and uses one background slot', () => {
    const env = setup();
    try {
        function start(url) { const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', url); xhr.send(); }
        for (let i = 0; i < 10; i++) start('https://sponsor.ajay.app/api/branding?videoID=synthetic-' + i);
        assert.equal(env.sent.length, 1);
        start('https://media.googlevideo.com/videoplayback?id=synthetic');
        start('https://media.googlevideo.com/videoplayback?id=synthetic&mime=audio%2Fmp4');
        start('https://www.youtube.com/api/stats/watchtime');
        start('https://sponsor.ajay.app/api/skipSegments/abcd');
        assert.deepEqual(env.sent.slice(-2).map(r => r.path), ['/api/stats/watchtime', '/api/skipSegments/abcd']);
        assert.equal(env.transport.summary().active, 5); assert.equal(env.transport.summary().queued, 9);
    } finally { env.close(); }
});
