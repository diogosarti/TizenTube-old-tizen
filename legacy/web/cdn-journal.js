(function (root) {
    'use strict';
    var KEY = 'tt-problem-cdns-v1', LIMIT = 50;
    var reasons = ['dns', 'tcp', 'tls', 'timeout', 'truncated', 'tls-wait', 'response-wait'];
    function validHost(host) {
        return typeof host === 'string' && host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+googlevideo\.com$/.test(host);
    }
    function create(storage, changed, clock) {
        var rows = [], candidates = [], revision = 0, addedAt = 0, persistent = true;
        clock = clock || function () { return Date.now(); };
        function find(list, host) {
            for (var i = 0; i < list.length; i++) if (list[i].host === host) return list[i];
            return null;
        }
        try {
            var raw = storage.getItem(KEY);
            var saved = raw && raw.length <= 32768 ? JSON.parse(raw) : [];
            if (Array.isArray(saved)) saved.slice(0, LIMIT).forEach(function (r) {
                if (!r || !validHost(r.host) || find(rows, r.host) || reasons.indexOf(r.reason) < 0 ||
                    ['auto', '1.2', '1.3'].indexOf(r.mode) < 0 || !isFinite(r.firstAt) || !isFinite(r.lastAt) ||
                    !(r.firstAt > 0) || !(r.lastAt >= r.firstAt) || !(r.count >= 2)) return;
                rows.push({ host: r.host, firstAt: +r.firstAt, lastAt: +r.lastAt, count: Math.min(999999, Math.floor(r.count)),
                    mode: r.mode, reason: r.reason });
            });
        } catch (_) { persistent = false; }
        function save() {
            revision++;
            try { storage.setItem(KEY, JSON.stringify(rows)); persistent = true; }
            catch (_) { persistent = false; }
            if (changed) { try { changed(); } catch (_) { /* Journal updates must not interrupt playback. */ } }
        }
        function trim() {
            if (rows.length < LIMIT) return;
            var ordered = rows.slice().sort(function (a, b) {
                return a.lastAt - b.lastAt;
            });
            rows.splice(rows.indexOf(ordered[0]), 1);
        }
        return {
            read: function () { return rows.map(function (r) {
                return { host: r.host, firstAt: r.firstAt, lastAt: r.lastAt, count: r.count,
                    mode: r.mode, reason: r.reason };
            }).sort(function (a, b) { return b.lastAt - a.lastAt; }); },
            summary: function () { return { count: rows.length,
                revision: revision, addedAt: addedAt, persistent: persistent }; },
            success: function (host) { candidates = candidates.filter(function (c) { return c.host !== host; }); },
            resetCandidates: function () { candidates = []; },
            failure: function (host, mode, reason, requestId, startedAt) {
                if (!validHost(host) || reasons.indexOf(reason) < 0 || ['auto', '1.2', '1.3'].indexOf(mode) < 0) return false;
                var now = clock(), row = find(rows, host), c;
                if (!row) {
                    c = find(candidates, host);
                    if (!c || now - c.lastAt > 600000) {
                        candidates = candidates.filter(function (item) { return item.host !== host; });
                        if (candidates.length >= LIMIT) candidates.shift();
                        candidates.push({ host: host, firstAt: now, lastAt: now, id: requestId });
                        return false;
                    }
                    if (c.id === requestId) return false;
                    candidates = candidates.filter(function (item) { return item !== c; });
                    if (!row) {
                        trim(); row = { host: host, firstAt: c.firstAt, count: 0 }; rows.push(row);
                    }
                    row.count = Math.min(999999, row.count + 2); addedAt = now;
                } else row.count = Math.min(999999, row.count + 1);
                row.lastAt = now; row.mode = mode; row.reason = reason; save();
                return true;
            },
            remove: function (host) {
                rows = rows.filter(function (r) { return r.host !== host; });
                candidates = candidates.filter(function (r) { return r.host !== host; }); save();
            },
            clear: function () { rows = []; candidates = []; addedAt = 0; save(); }
        };
    }
    var api = { create: create, validHost: validHost };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LegacyCDNJournal = api;
}(typeof window !== 'undefined' ? window : this));
