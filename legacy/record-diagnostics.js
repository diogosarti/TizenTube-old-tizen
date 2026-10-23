'use strict';

// PC-side recorder. Reads existing diagnostics without changing playback.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { clean } = require('./web/logger');

function snapshot() {
    if (!window.__legacyLog || !window.__legacyTLS) return { app: false };
    var out = { app: true, epoch: performance.timing.navigationStart, logs: window.__legacyLog.read(), tls: window.__legacyTLS.summary() };
    out.native = window.__legacyTLS.inspect(); // Previous asynchronous reply; refreshed on the next poll.
    try {
        var frame = document.querySelector('iframe'), w = frame && frame.contentWindow;
        var d = w && w.document, v = d && d.querySelector('video'), p = d && d.querySelector('.html5-video-player');
        out.frame = w && w.performance.timing.navigationStart;
        if (v) {
            var ranges = [];
            for (var i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i), v.buffered.end(i)]);
            out.video = { time: v.currentTime, duration: v.duration, rate: v.playbackRate, paused: v.paused, seeking: v.seeking,
                ready: v.readyState, network: v.networkState, muted: v.muted, volume: v.volume,
                width: v.videoWidth, height: v.videoHeight, error: v.error ? v.error.code : 0, buffered: ranges };
        }
        if (p && p.getVideoStats) {
            var s = p.getVideoStats(), stats = {};
            ['fmt', 'afmt', 'lvb', 'lab', 'lvr', 'lva', 'lar', 'laa', 'lvq', 'laq', 'vbu', 'vbs', 'vpl', 'vsk', 'reqBlocked'].forEach(function (k) {
                if (typeof s[k] === 'number' || typeof s[k] === 'string') stats[k] = s[k];
            });
            out.stats = stats;
        }
    } catch (e) { out.frameUnavailable = true; }
    return out;
}

// A second allowlist on the PC prevents unexpected page data reaching disk.
function sanitize(s) {
    const out = { app: s.app === true, epoch: Number(s.epoch) || 0, frame: Number(s.frame) || 0 };
    out.logs = (Array.isArray(s.logs) ? s.logs : []).map(e => ({
        n: Number(e.n) || 0, ms: Number(e.ms) || 0, code: clean(e.code),
        detail: /^(page\.error|promise\.)/.test(e.code) ? '[message omitted]' : clean(e.detail)
    }));
    if (s.video) {
        out.video = {};
        for (const k of ['time', 'duration', 'rate', 'ready', 'network', 'volume', 'width', 'height', 'error']) {
            if (Number.isFinite(s.video[k])) out.video[k] = s.video[k];
        }
        for (const k of ['paused', 'seeking', 'muted']) out.video[k] = s.video[k] === true;
        out.video.buffered = (Array.isArray(s.video.buffered) ? s.video.buffered : []).slice(0, 32)
            .filter(r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite));
    }
    out.stats = {};
    for (const k of ['fmt', 'afmt', 'lvb', 'lab', 'lvr', 'lva', 'lar', 'laa', 'lvq', 'laq', 'vbu', 'vbs', 'vpl', 'vsk', 'reqBlocked']) {
        const value = s.stats && s.stats[k];
        if (typeof value === 'number' && Number.isFinite(value)) out.stats[k] = value;
        else if (typeof value === 'string' && /^[\d\s.,:;()\[\]+\-\/]*$/.test(value)) out.stats[k] = value.slice(0, 512);
        else if (k === 'reqBlocked' && /^(readaheadmet|ratelimited|none)$/.test(value)) out.stats[k] = value;
    }
    out.tls = {};
    out.native = (Array.isArray(s.native) ? s.native : []).slice(0, 32).map(request => {
        const result = {};
        for (const k of ['id', 'rid', 'itag', 'operation', 'received', 'remaining', 'input', 'output', 'readCall', 'readSize',
            'phaseMs', 'elapsedMs', 'idleReadMs', 'dnsMs', 'tcpMs', 'tlsMs', 'sendMs', 'headersMs', 'bodyMs', 'wireReceived', 'wireSent', 'readCompletions', 'tickets']) {
            if (Number.isFinite(request[k])) result[k] = request[k];
        }
        for (const k of ['headers', 'chunked', 'readPending', 'writePending', 'connectionReused']) result[k] = request[k] === true;
        if (/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method)) result.method = request.method;
        if (/^(auto|1\.2|1\.3)$/.test(request.mode)) result.mode = request.mode;
        if (/^(api|audio|video|unknown)$/.test(request.kind)) result.kind = request.kind;
        if (/^(dns|tcp|tls|send|headers|body)$/.test(request.phase)) result.phase = request.phase;
        if (typeof request.endpoint === 'string' && /^[a-zA-Z_]{1,32}$/.test(request.endpoint)) result.endpoint = request.endpoint;
        if (typeof request.host === 'string' && /^(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|googlevideo\.com|googleapis\.com|google\.com|gstatic\.com|ajay\.app)$|^(?:api|localhost)$/.test(request.host)) result.host = request.host;
        return result;
    });
    for (const k of ['active', 'queued', 'completed', 'bytes', 'errors']) {
        if (s.tls && Number.isFinite(s.tls[k])) out.tls[k] = s.tls[k];
    }
    for (const k of ['mode', 'api', 'video', 'audio', 'system', 'apiCipher', 'videoCipher', 'audioCipher']) {
        const value = s.tls && s.tls[k];
        if (typeof value === 'string' && /^(?:auto|1\.[23]|tls1[23]|unknown|TLS[ _A-Z0-9.\-]+)$/.test(value)) out.tls[k] = value;
    }
    return out;
}

class Writer {
    constructor(dir, maxBytes = 16 * 1024 * 1024, keep = 32) {
        fs.mkdirSync(dir, { recursive: true });
        this.dir = dir; this.maxBytes = maxBytes; this.keep = keep; this.bytes = 0; this.index = 0;
        this.prefix = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
    }
    write(value) {
        const line = JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n';
        const size = Buffer.byteLength(line);
        if (!this.file || this.bytes + size > this.maxBytes) {
            this.file = path.join(this.dir, 'ttdiag-' + this.prefix + '-' + (++this.index) + '.jsonl');
            fs.closeSync(fs.openSync(this.file, 'wx'));
            this.bytes = 0;
            const files = fs.readdirSync(this.dir).filter(n => /^ttdiag-[\dTZ.\-]+-\d+-\d+\.jsonl$/.test(n))
                .map(n => ({ n, time: fs.statSync(path.join(this.dir, n)).mtimeMs }))
                .sort((a, b) => (path.join(this.dir, a.n) === this.file ? -1 : path.join(this.dir, b.n) === this.file ? 1 : b.time - a.time));
            for (const f of files.slice(this.keep)) if (path.join(this.dir, f.n) !== this.file) fs.unlinkSync(path.join(this.dir, f.n));
        }
        fs.appendFileSync(this.file, line, 'utf8'); this.bytes += size;
    }
}

function pages(host, port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: host, port, path: '/pagelist.json', timeout: 2000 }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) req.destroy(); });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('discovery')); } });
        });
        req.on('timeout', () => req.destroy()); req.on('error', reject);
    });
}

async function record(host, dir) {
    const writer = new Writer(dir);
    let stopped = false, socket, epoch = 0, cursor = 0, previous, lastNotice = '';
    const notice = state => {
        if (state !== lastNotice) { writer.write({ type: 'recorder', state }); console.log(new Date().toLocaleTimeString(), state); lastNotice = state; }
    };
    process.on('SIGINT', () => { stopped = true; if (socket) socket.terminate(); });
    process.on('SIGTERM', () => { stopped = true; if (socket) socket.terminate(); });
    console.log('Diagnostics folder:', dir, '\nKeep this window open. Ctrl+C stops recording.');
    while (!stopped) {
        try {
            let endpoint;
            for (const port of [7011, 7012]) {
                try { const list = await pages(host, port); if (list[0] && /^\d+$/.test(String(list[0].id))) { endpoint = `ws://${host}:${port}/devtools/page/${list[0].id}`; break; } } catch { /* Retry discovery. */ }
            }
            if (!endpoint) throw new Error('unavailable');
            socket = new WebSocket(endpoint, { handshakeTimeout: 3000 });
            socket.on('error', () => {}); // The connection/request promises report failures.
            await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
            let id = 0;
            const evaluate = () => new Promise((resolve, reject) => {
                const requestId = ++id;
                const finish = (error, value) => { clearTimeout(timer); socket.removeListener('message', message); socket.removeListener('close', closed); error ? reject(error) : resolve(value); };
                const closed = () => finish(new Error('disconnected'));
                const message = raw => {
                    try {
                        const reply = JSON.parse(raw);
                        if (reply.id !== requestId) return;
                        const result = reply.result;
                        if (!result || result.wasThrown || !result.result || typeof result.result.value !== 'string') return finish(new Error('evaluation'));
                        finish(null, sanitize(JSON.parse(result.result.value)));
                    } catch { finish(new Error('protocol')); }
                };
                const timer = setTimeout(() => finish(new Error('timeout')), 8000);
                socket.on('message', message); socket.once('close', closed);
                socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify((' + snapshot.toString() + ')())', returnByValue: true } }));
            });
            previous = undefined;
            while (!stopped && socket.readyState === WebSocket.OPEN) {
                const started = performance.now(), s = await evaluate();
                if (!s.app) throw new Error('different-app');
                notice('recording');
                const last = s.logs.length ? s.logs[s.logs.length - 1].n : 0;
                if (epoch !== s.epoch || last < cursor) { epoch = s.epoch; cursor = 0; writer.write({ type: 'app-session' }); previous = undefined; }
                const fresh = s.logs.filter(e => e.n > cursor);
                if (fresh.length && cursor && fresh[0].n > cursor + 1) writer.write({ type: 'log-gap', lost: fresh[0].n - cursor - 1 });
                for (const entry of fresh) writer.write({ type: 'app', ...entry });
                cursor = Math.max(cursor, last);
                const now = performance.now(), sample = { type: 'sample', pollMs: now - started, frame: s.frame, video: s.video, stats: s.stats, tls: s.tls, nativePreviousPoll: s.native };
                if (previous && previous.frame === s.frame && previous.time !== undefined && s.video && !s.video.seeking) {
                    sample.clockRatio = (s.video.time - previous.time) / ((now - previous.now) / 1000);
                }
                writer.write(sample);
                previous = { now, frame: s.frame, time: s.video && s.video.time };
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!stopped) notice('disconnected; waiting for TV debug session (no automatic app restart)');
        } catch (error) {
            if (error.code && /^(ENOSPC|EACCES|EPERM|EROFS|EIO)$/.test(error.code)) throw error;
            if (!stopped) {
                notice('disconnected; waiting for TV debug session (no automatic app restart)');
                const reason = /^(unavailable|disconnected|evaluation|protocol|timeout|different-app)$/.test(error.message) ? error.message : 'connection';
                writer.write({ type: 'retry', reason });
            }
        } finally { if (socket) socket.terminate(); }
        if (!stopped) await new Promise(r => setTimeout(r, 3000));
    }
    notice('stopped');
}

if (require.main === module) {
    const [host, dir] = process.argv.slice(2);
    if (!host || !/^[a-zA-Z0-9.-]+$/.test(host) || !dir) { console.error('Usage: node record-diagnostics.js TV_ADDRESS OUTPUT_DIRECTORY'); process.exitCode = 1; }
    else record(host, path.resolve(dir)).catch(() => { console.error('Recording stopped: cannot write diagnostics. Check free space and permissions.'); process.exitCode = 1; });
}
module.exports = { sanitize, Writer, snapshot };
