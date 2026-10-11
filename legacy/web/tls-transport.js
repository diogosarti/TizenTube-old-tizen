(function (root) {
    'use strict';
    var CONFIG_KEY = 'ytaf-configuration';
    function validMode(value) { return value === '1.2' || value === '1.3' ? value : 'auto'; }
    function resolve(win, value, base) {
        value = String(value);
        if (base && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            var b = win.document.createElement('a'); b.href = base;
            value = value.indexOf('//') === 0 ? b.protocol + value : b.protocol + '//' + b.host +
                (value.charAt(0) === '/' ? value : b.pathname.replace(/[^/]*$/, '') + value);
        }
        var a = win.document.createElement('a'); a.href = value; return a;
    }
    function category(url) { return /(^|\.)googlevideo\.com$/i.test(url.hostname) ? 'video' : 'api'; }
    function bytes(win, value, callback) {
        if (value === undefined || value === null) { callback(new root.ArrayBuffer(0)); return; }
        if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') { callback(value); return; }
        if (value.buffer && typeof value.byteLength === 'number') {
            callback(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)); return;
        }
        if (win.Blob && value instanceof win.Blob) {
            var reader = new win.FileReader(); reader.onload = function () { callback(reader.result); };
            reader.onerror = function () { callback(null); }; reader.readAsArrayBuffer(value); return;
        }
        if (value.nodeType) value = new win.XMLSerializer().serializeToString(value);
        var text = unescape(encodeURIComponent(String(value))), array = new root.Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) array[i] = text.charCodeAt(i);
        callback(array.buffer);
    }
    function combine(chunks, length) {
        var all = new root.Uint8Array(length), at = 0;
        for (var i = 0; i < chunks.length; i++) { all.set(new root.Uint8Array(chunks[i]), at); at += chunks[i].byteLength; }
        return all.buffer;
    }
    function text(buffer) {
        // Decode UTF-8 without depending on TextDecoder in the 2016 browser.
        var array = new root.Uint8Array(buffer), result = [], part = '';
        for (var i = 0; i < array.length;) {
            var c = array[i++], n = c < 128 ? 0 : c >= 194 && c <= 223 ? 1 : c >= 224 && c <= 239 ? 2 : c >= 240 && c <= 244 ? 3 : -1;
            var cp = n === 0 ? c : c & (n === 1 ? 31 : n === 2 ? 15 : 7), start = i;
            if (n < 0) { part += '\ufffd'; continue; }
            for (var j = 0; j < n && i < array.length && (array[i] & 192) === 128; j++) cp = cp * 64 + (array[i++] & 63);
            if (i - start !== n || (n === 1 && cp < 128) || (n === 2 && cp < 2048) || (n === 3 && cp < 65536) || cp > 1114111 || (cp >= 55296 && cp <= 57343)) part += '\ufffd';
            else if (cp < 65536) part += String.fromCharCode(cp);
            else { cp -= 65536; part += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023)); }
            if (part.length > 8192) { result.push(part); part = ''; }
        }
        result.push(part); return result.join('');
    }
    function headers(raw) {
        var result = {}, lines = String(raw).split('\r\n');
        for (var i = 0; i < lines.length; i++) {
            var colon = lines[i].indexOf(':'); if (colon < 1) continue;
            var name = lines[i].slice(0, colon).toLowerCase(), value = lines[i].slice(colon + 1).replace(/^\s+|\s+$/g, '');
            if (name === 'set-cookie' || name === 'set-cookie2') continue;
            result[name] = result[name] ? result[name] + ', ' + value : value;
        }
        return result;
    }
    function create(container, log, changed) {
        var module, ready = false, failed = false, sequence = 0, active = 0, requests = {}, queue = [], mode = 'auto';
        var stats = { api: {}, video: {}, errors: 0, completed: 0, bytes: 0 };
        var last = { api: 'unknown', video: 'unknown' }, diagnostics = [], mediaKey = '', media = { video: 'unknown', audio: 'unknown' };
        try { mode = validMode(JSON.parse(root.localStorage.getItem(CONFIG_KEY) || '{}').tlsMode); } catch (_) {}
        function notify() { if (changed) changed(summary()); }
        function summary() {
            return { mode: mode, api: last.api, video: last.video, system: 'unknown', active: active, queued: queue.length,
                audio: media.audio, completed: stats.completed, bytes: stats.bytes, errors: stats.errors, ready: ready, failed: failed };
        }
        function record(group, tls) {
            last[group] = tls;
            stats[group][tls] = (stats[group][tls] || 0) + 1; notify();
        }
        function pump() {
            if (!ready || failed) return;
            while (active < 6 && queue.length) {
                var r = queue.shift(); if (!requests[r.id]) continue;
                active++; r.active = true;
                var u = resolve(root, r.url), lines = '', h = r.headers;
                for (var key in h) if (Object.prototype.hasOwnProperty.call(h, key)) lines += key + ': ' + h[key] + '\r\n';
                if (!h['user-agent']) lines += 'User-Agent: ' + root.navigator.userAgent + '\r\n';
                module.postMessage({ type: 'request', id: r.id, method: r.method, host: u.hostname,
                    port: +(u.port || 443), path: (u.pathname.charAt(0) === '/' ? u.pathname : '/' + u.pathname) + u.search,
                    headers: lines, body: r.body, mode: r.mode });
            }
            notify();
        }
        function remove(r) {
            delete requests[r.id]; if (r.active) active--; r.active = false;
            queue = queue.filter(function (item) { return item !== r; });
            setTimeout(pump, 0);
        }
        function abort(r) {
            if (!r || !requests[r.id]) return;
            if (r.active) module.postMessage({ type: 'abort', id: r.id });
            remove(r); r.callback = null;
        }
        function requeue(r) {
            delete requests[r.id]; active--; r.active = false;
            r.id = ++sequence; requests[r.id] = r; queue.push(r); setTimeout(pump, 0);
        }
        function request(method, url, h, body, callback) {
            var r = { id: ++sequence, method: method, url: url, headers: h, body: body, callback: callback, mode: mode, redirects: 0, retries: 0, group: category(resolve(root, url)) };
            var u = resolve(root, url), key = /(?:[?&])id=([^&]+)/.exec(u.search), mime = /(?:[?&])mime=([^&]+)/.exec(u.search);
            if (r.group === 'video' && u.pathname === '/videoplayback') {
                r.mediaKey = key ? key[1] : mediaKey;
                r.mediaKind = mime && /^audio(?:%2f|\/)/i.test(mime[1]) ? 'audio' : 'video';
                if (r.mediaKey !== mediaKey) { mediaKey = r.mediaKey; media = { video: 'unknown', audio: 'unknown' }; last.video = 'unknown'; notify(); }
            }
            requests[r.id] = r; queue.push(r);
            if (failed) setTimeout(function () { remove(r); callback({ type: 'error', error: 'NaCl transport unavailable' }); }, 0);
            else pump();
            return r;
        }
        function moduleFailure() {
            if (failed) return;
            failed = true; ready = false; log.record('tls.module-error', 'NaCl transport unavailable');
            Object.keys(requests).forEach(function (id) { var r = requests[id]; remove(r); if (r.callback) r.callback({ type: 'error', error: 'NaCl transport unavailable' }); });
            notify();
        }
        container.addEventListener('message', function (event) {
            var m = event.data;
            if (!m || typeof m !== 'object') return;
            if (m.type === 'diagnostics') { diagnostics = m.requests; return; }
            if (m.type === 'ready') {
                ready = !!m.ok;
                if (!ready) { log.record('tls.module-init', 'code=' + m.code); moduleFailure(); return; }
                log.record('tls.ready', 'Mbed TLS 3.6.7; certificate and hostname verification required'); pump(); return;
            }
            var r = requests[m.id]; if (!r || !r.callback) return;
            if (m.type === 'tls') {
                if (!m.verified) { var rejected = r.callback; abort(r); rejected({ type: 'error', error: 'Certificate verification failed' }); return; }
                r.transport = m.tls.replace('TLSv', 'TLS ');
                if (r.group !== 'video') record(r.group, r.transport);
                log.record('tls.connection', r.group + '; ' + m.tls + '; verified=true; mode=' + r.mode);
            } else if (m.type === 'headers') {
                var h = headers(m.headers), redirect = h.location && [301, 302, 303, 307, 308].indexOf(m.status) >= 0;
                if (redirect) {
                    var next;
                    try { next = resolve(root, h.location, r.url); } catch (_) {}
                    if (!next || next.protocol !== 'https:' || ++r.redirects > 10) {
                        var cb = r.callback; abort(r); cb({ type: 'error', error: 'Unsafe or excessive redirect' }); return;
                    }
                    module.postMessage({ type: 'abort', id: r.id });
                    if (next.host !== resolve(root, r.url).host) { delete r.headers.authorization; delete r.headers.cookie; }
                    if ((m.status === 303 && r.method !== 'HEAD') || ((m.status === 301 || m.status === 302) && r.method === 'POST')) {
                        r.method = 'GET'; r.body = new root.ArrayBuffer(0); delete r.headers['content-type'];
                    }
                    r.url = next.href; requeue(r); return;
                }
                m.headers = h; m.url = r.url;
                r.mediaSuccess = m.status === 200 || m.status === 206;
                if (/^audio\//i.test(h['content-type'] || '')) r.mediaKind = 'audio';
            } else if (m.type === 'done' || m.type === 'error') {
                if (m.type === 'error' && m.retryable && r.retries++ < 1) {
                    log.record('tls.retry', r.group + '; reset before HTTP; mode=' + r.mode);
                    requeue(r); return;
                }
                remove(r);
                if (m.type === 'done') stats.completed++;
                else { stats.errors++; log.record('tls.request-error', r.group + '; ' + m.error); }
                notify();
            } else if (m.type === 'data') {
                stats.bytes += m.body.byteLength;
                if (r.mediaKind && r.mediaSuccess && r.mediaKey === mediaKey && r.transport) {
                    media[r.mediaKind] = r.transport;
                    if (r.mediaKind === 'video') record('video', r.transport);
                    else notify();
                }
            }
            r.callback(m);
        }, true);
        container.addEventListener('error', moduleFailure, true);
        container.addEventListener('crash', moduleFailure, true);
        module = root.document.createElement('embed'); module.type = 'application/x-nacl'; module.src = 'tls-client.nmf';
        module.width = 1; module.height = 1; container.appendChild(module);
        var startTimer = setTimeout(function () { if (!ready) moduleFailure(); }, 30000);
        container.addEventListener('load', function () { if (ready) clearTimeout(startTimer); }, true);
        var api = { request: request, abort: abort, summary: summary,
            setMode: function (value) {
                mode = validMode(value);
                // Already-open connections retain their negotiated version until playback/reload creates new ones.
                notify(); log.record('tls.mode', mode);
            },
            system: function (group) { if (group === 'video' && last.video !== 'unknown') { last.video = 'unknown'; media = { video: 'unknown', audio: 'unknown' }; notify(); } },
            inspect: function () { module.postMessage({ type: 'inspect' }); return diagnostics; },
            install: function (win) { install(win, api); }
        };
        return api;
    }
    function install(win, transport) {
        var NativeXHR = win.XMLHttpRequest, live = [];
        function events(object) {
            var listeners = {};
            object.addEventListener = function (type, cb) { (listeners[type] || (listeners[type] = [])).push(cb); };
            object.removeEventListener = function (type, cb) { var list = listeners[type] || []; listeners[type] = list.filter(function (fn) { return fn !== cb; }); };
            object._event = function (type, loaded, total) {
                var event = { type: type, target: object, currentTarget: object, loaded: loaded || 0, total: total || 0, lengthComputable: total > 0 };
                var callbacks = (listeners[type] || []).slice(); if (typeof object['on' + type] === 'function') callbacks.unshift(object['on' + type]);
                callbacks.forEach(function (cb) { try { if (typeof cb === 'function') cb.call(object, event); else if (cb && cb.handleEvent) cb.handleEvent(event); } catch (e) { setTimeout(function () { throw e; }, 0); } });
            };
        }
        function XHR() {
            this.upload = {}; events(this.upload); events(this);
            this._native = null; this._request = null; this._state = 0; this._status = 0; this._statusText = ''; this._url = '';
            this._headers = {}; this._responseHeaders = {}; this._chunks = []; this._length = 0; this._body = null;
            this.timeout = 0; this.withCredentials = false; this.responseType = ''; this._sent = false;
            this._generation = 0;
        }
        function state(xhr, value) { xhr._state = value; xhr._event('readystatechange'); }
        function untrack(xhr) { clearTimeout(xhr._timer); live = live.filter(function (item) { return item !== xhr; }); xhr._request = null; xhr._sent = false; }
        function fail(xhr, type) {
            var generation = xhr._generation;
            transport.abort(xhr._request); untrack(xhr); xhr._chunks = []; xhr._body = null; xhr._length = 0;
            xhr._status = 0; xhr._statusText = ''; xhr._responseHeaders = {}; xhr._url = '';
            state(xhr, 4);
            if (xhr._generation !== generation) return;
            xhr._event(type);
            if (xhr._generation === generation) xhr._event('loadend');
        }
        XHR.prototype.open = function (method, url, async, user, password) {
            this.abort(); this._method = String(method).toUpperCase(); this._headers = {}; this._responseHeaders = {}; this._chunks = []; this._length = 0; this._body = null;
            this._generation++;
            this._status = 0; this._statusText = ''; this._url = ''; this._native = null;
            var u = resolve(win, url);
            this._target = u.href;
            if (u.protocol !== 'https:') {
                if (u.protocol === 'http:') transport.system(category(u));
                this._native = new NativeXHR(); var self = this;
                ['readystatechange', 'loadstart', 'progress', 'abort', 'error', 'timeout', 'load', 'loadend'].forEach(function (name) {
                    self._native.addEventListener(name, function (event) { self._event(name, event.loaded, event.total); });
                });
                this._native.open(method, url, async === undefined ? true : async, user, password); return;
            }
            if (async === false) throw new Error('Synchronous HTTPS XHR is unavailable through NaCl');
            if (u.username || u.password || user || password) throw new Error('URL credentials are unsupported');
            state(this, 1);
        };
        XHR.prototype.setRequestHeader = function (name, value) {
            if (this._native) { this._native.setRequestHeader(name, value); return; }
            if (this._state !== 1 || this._sent) throw new Error('InvalidStateError');
            name = String(name).toLowerCase(); value = String(value);
            if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('Invalid HTTP header');
            this._headers[name] = this._headers[name] ? this._headers[name] + ', ' + value : value;
        };
        XHR.prototype.getResponseHeader = function (name) {
            return this._native ? this._native.getResponseHeader(name) : this._state < 2 ? null : this._responseHeaders[String(name).toLowerCase()] || null;
        };
        XHR.prototype.getAllResponseHeaders = function () {
            if (this._native) return this._native.getAllResponseHeaders();
            if (this._state < 2) return '';
            var lines = [], h = this._responseHeaders;
            Object.keys(h).forEach(function (name) { lines.push(name + ': ' + h[name] + '\r\n'); }); return lines.join('');
        };
        XHR.prototype.overrideMimeType = function (value) { this._mime = String(value); if (this._native) this._native.overrideMimeType(value); };
        XHR.prototype.abort = function () {
            if (this._native) { this._native.abort(); return; }
            var generation = this._generation;
            if (this._sent) fail(this, 'abort');
            if (this._generation === generation) this._state = 0;
        };
        XHR.prototype.send = function (value) {
            if (this._native) { this._native.timeout = this.timeout; this._native.withCredentials = this.withCredentials; this._native.responseType = this.responseType; this._native.send(value); return; }
            if (this._state !== 1 || this._sent) throw new Error('InvalidStateError');
            if (['', 'text', 'arraybuffer', 'blob', 'json', 'document'].indexOf(this.responseType) < 0) throw new Error('Unsupported responseType');
            var self = this, generation = this._generation; this._sent = true; live.push(this); this._event('loadstart');
            if (this._generation !== generation || !this._sent) return;
            if (this.timeout > 0) this._timer = setTimeout(function () { if (self._generation === generation && self._sent) fail(self, 'timeout'); }, this.timeout);
            if (value !== undefined && value !== null && typeof value === 'string' && !this._headers['content-type']) this._headers['content-type'] = 'text/plain;charset=UTF-8';
            bytes(win, this._method === 'GET' || this._method === 'HEAD' ? null : value, function (body) {
                if (!self._sent || self._generation !== generation) return;
                if (!body) { fail(self, 'error'); return; }
                self._request = transport.request(self._method, self._target, self._headers, body, function (m) {
                    if (!self._sent || self._generation !== generation) return;
                    if (m.type === 'headers') {
                        self._status = m.status; self._statusText = m.statusText; self._responseHeaders = m.headers; self._url = m.url; state(self, 2);
                    } else if (m.type === 'data') {
                        self._chunks.push(m.body); self._length += m.body.byteLength;
                        if (self._state !== 3) state(self, 3);
                        if (self._sent && self._generation === generation) self._event('progress', self._length, +self._responseHeaders['content-length'] || 0);
                    } else if (m.type === 'done') {
                        self._body = combine(self._chunks, self._length); self._chunks = []; untrack(self);
                        state(self, 4);
                        if (self._generation !== generation) return;
                        self._event('load', self._length, self._length);
                        if (self._generation === generation) self._event('loadend', self._length, self._length);
                    } else if (m.type === 'error') fail(self, m.error === 'timeout' ? 'timeout' : 'error');
                });
                self.upload._event('loadstart'); self.upload._event('progress', body.byteLength, body.byteLength);
                self.upload._event('load'); self.upload._event('loadend');
            });
        };
        function buffer(xhr) { return xhr._body || combine(xhr._chunks, xhr._length); }
        function responseText(xhr) {
            if (xhr.responseType && xhr.responseType !== 'text') throw new Error('InvalidStateError');
            return xhr._state < 3 ? '' : text(buffer(xhr));
        }
        function responseXML(xhr) {
            if (xhr._state !== 4 || !xhr._body) return null;
            var mime = xhr._mime || xhr._responseHeaders['content-type'] || 'text/xml';
            return new win.DOMParser().parseFromString(text(xhr._body), mime.indexOf('text/html') === 0 ? 'text/html' : 'text/xml');
        }
        var getters = {
            readyState: function () { return this._state; }, status: function () { return this._status; }, statusText: function () { return this._statusText; },
            responseURL: function () { return this._url; }, responseText: function () { return responseText(this); }, responseXML: function () { return responseXML(this); },
            response: function () {
                if (!this.responseType || this.responseType === 'text') return responseText(this);
                if (this._state !== 4 || !this._body) return null;
                if (this.responseType === 'arraybuffer') return this._body;
                if (this.responseType === 'blob') return new win.Blob([this._body], { type: this._mime || this._responseHeaders['content-type'] || '' });
                if (this.responseType === 'document') return responseXML(this);
                try { return JSON.parse(text(this._body)); } catch (_) { return null; }
            }
        };
        Object.keys(getters).forEach(function (key) { Object.defineProperty(XHR.prototype, key, { get: function () { return this._native ? this._native[key] : getters[key].call(this); } }); });
        ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (name, index) { XHR[name] = XHR.prototype[name] = index; });
        win.XMLHttpRequest = XHR;
        // The compatibility bundle installs whatwg-fetch over this XHR implementation.
        win.fetch = undefined;
        if (win.navigator.sendBeacon) win.navigator.sendBeacon = function (url, data) { var xhr = new XHR(); xhr.open('POST', url, true); xhr.send(data); return true; };
        win.addEventListener('unload', function () { live.slice().forEach(function (xhr) { xhr.abort(); }); });
    }
    root.LegacyTLS = { create: create, install: install };
}(typeof window !== 'undefined' ? window : this));
