(function (root) {
    'use strict';
    function clean(value) {
        return String(value === undefined ? '' : value)
            .replace(/(?:authorization|cookie|password|token|secret|signature|api[_-]?key)\s*[:=]\s*[^\n]+/gi, '[redacted]')
            .replace(/https?:[^\s"'<>]+/gi, '[url]')
            .replace(/[A-Za-z]:[\\/][^\s"'<>]+|\/(?:home|Users|tmp|opt)\/[^\s"'<>]+/g, '[path]')
            .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
            .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]')
            .replace(/[A-Za-z0-9_+\/=.-]{40,}/g, '[redacted]')
            .replace(/[\r\n\t]/g, ' ').slice(0, 400);
    }
    function create(limit, onRecord) {
        var entries = [];
        var sequence = 0;
        var start = Date.now();
        return {
            record: function (code, detail) {
                var entry = { n: ++sequence, ms: Date.now() - start, code: clean(code).slice(0, 64), detail: clean(detail) };
                entries.push(entry);
                if (entries.length > limit) entries.shift();
                if (onRecord) {
                    try { onRecord(entry); } catch (error) { /* Diagnostics must not interrupt playback. */ }
                }
                return entry;
            },
            read: function () { return entries.slice(); }
        };
    }
    var api = { clean: clean, create: create };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LegacyLogger = api;
}(typeof window !== 'undefined' ? window : this));
