'use strict';
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var URL = require('url');
var proxy = require('./proxy');
var Logger = require('./web/logger');
var PORT = 8124;
var service;

function createServer(assetRoot) {
    var log = Logger.create(500);
    var assets = {
        '/__legacy/logger.js': 'logger.js', '/__legacy/frame.js': 'frame.js',
        '/__legacy/compat.js': 'compat.js', '/__legacy/userScript.js': 'userScript.js',
        '/__legacy/index.html': 'index.html', '/__legacy/widget.js': 'widget.js'
    };
    var server = http.createServer(function (req, res) {
        var pathname = URL.parse(req.url).pathname;
        var local = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.connection.remoteAddress);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (local) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        }
        function json(value) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
        if (req.method === 'GET' && pathname === '/__legacy/logs') { json(log.read()); return; }
        if (!local) { res.writeHead(403); res.end('Local playback requests only'); return; }
        if (pathname === '/__legacy/health') { json({ version: '0.1.0', node: process.version }); return; }
        if (pathname === '/__legacy/log' && req.method === 'POST') {
            var body = '', oversized = false;
            req.on('data', function (chunk) {
                body += chunk;
                if (body.length > 4096) { oversized = true; body = ''; req.destroy(); }
            });
            req.on('end', function () {
                if (oversized) return;
                try { var entry = JSON.parse(body); log.record(entry.code, entry.detail); res.end('ok'); }
                catch (e) { res.writeHead(400); res.end('Invalid log entry'); }
            });
            return;
        }
        if (assets[pathname]) {
            fs.readFile(path.join(assetRoot, assets[pathname]), function (error, bytes) {
                if (error) { res.writeHead(404); res.end('Missing packaged asset'); return; }
                res.setHeader('Content-Type', pathname.indexOf('.html') !== -1 ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8'); res.end(bytes);
            });
            return;
        }
        var target;
        try { target = proxy.targetFor(req.url); } catch (e) { res.writeHead(403); res.end('Blocked target'); return; }
        var mods = !/(?:[?&])legacy_mods=0(?:&|$)/.test(req.url);
        target.path = target.path.replace(/([?&])legacy_mods=0(&|$)/, function (_, sep, tail) { return tail ? sep : ''; });
        var headers = {
            'user-agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.1 TV Safari/538.1',
            'accept-encoding': 'identity', 'origin': 'https://www.youtube.com', 'referer': 'https://www.youtube.com/tv'
        };
        ['accept', 'accept-language', 'content-type', 'range', 'x-youtube-client-name', 'x-youtube-client-version', 'x-goog-visitor-id'].forEach(function (key) {
            if (req.headers[key]) headers[key] = req.headers[key];
        });
        var origin = 'http://localhost:' + server.address().port;
        var kind = target.hostname.indexOf('googlevideo.com') !== -1 ? 'media' : /\.js$|\/(?:js|base\.js)(?:\/|$)/.test(target.pathname) ? 'script' : pathname === '/tv' ? 'page' : 'resource';
        var upstream = (target.protocol === 'https:' ? https : http).request({
            protocol: target.protocol, hostname: target.hostname, port: target.port,
            path: target.path, method: req.method, headers: headers
        }, function (response) {
            var contentType = response.headers['content-type'] || '';
            var text = /html|json|javascript|text\/css/.test(contentType);
            var isPage = /html/.test(contentType) && /^\/tv(?:[/?]|$)/.test(target.path);
            log.record('http.' + kind, 'status=' + response.statusCode);
            res.statusCode = response.statusCode;
            ['content-type', 'content-range', 'accept-ranges'].forEach(function (key) {
                if (response.headers[key]) res.setHeader(key, response.headers[key]);
            });
            if (response.headers.location) {
                var resolved = URL.resolve(URL.format(target), response.headers.location);
                res.setHeader('Location', proxy.rewrite(resolved, origin));
            }
            if (text) {
                var chunks = [], size = 0;
                response.on('data', function (chunk) {
                    size += chunk.length;
                    if (size > 16 * 1024 * 1024) { upstream.destroy(); res.destroy(); log.record('http.too-large', kind); return; }
                    chunks.push(chunk);
                });
                response.on('end', function () {
                    var source = Buffer.concat(chunks).toString('utf8');
                    res.end(isPage ? proxy.html(source, origin, mods) : proxy.rewrite(source, origin));
                });
            } else {
                response.pipe(res);
            }
            response.on('error', failed);
        });
        function failed(error) {
            log.record('http.error', kind + '; host=' + target.hostname + '; ' + (error.code || error.name));
            if (!res.headersSent) { res.writeHead(502); res.end('Upstream connection failed. See memory log.'); }
            else res.destroy();
        }
        upstream.on('error', failed);
        upstream.setTimeout(30000, function () { log.record('http.timeout', kind); upstream.destroy(); if (!res.headersSent) res.writeHead(504); res.end('Upstream timeout'); });
        req.on('aborted', function () { upstream.destroy(); });
        req.pipe(upstream);
    });
    server.memoryLog = log;
    log.record('service.start', 'Node=' + process.version + '; port=' + PORT);
    server.on('error', function (error) { log.record('service.error', error.code || error.name); });
    return server;
}
function start() {
    if (service) return;
    service = createServer(path.join(__dirname, '..'));
    service.listen(PORT, '0.0.0.0');
}
function stop() { if (service) service.close(); service = null; }
module.exports = { onStart: start, onRequest: start, onStop: stop, createServer: createServer };
if (typeof tizen !== 'undefined' || require.main === module) start();
