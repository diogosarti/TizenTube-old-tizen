import 'core-js/stable';
import 'whatwg-fetch';

window.__legacyDirect = true;

// Keep YouTube's current-account callback; do not cache credentials ourselves.
let playerAuthorization;
window.yt = window.yt || {};
window.yt.player = window.yt.player || {};
window.yt.player.Application = window.yt.player.Application || {};
['create', 'createAlternate'].forEach(function (name) {
    let create;
    Object.defineProperty(window.yt.player.Application, name, {
        configurable: true,
        get: function () { return create; },
        set: function (value) {
            create = typeof value === 'function' ? function () {
                playerAuthorization = arguments[3];
                return value.apply(this, arguments);
            } : value;
        }
    });
});

// The document keeps the widget origin; resolve YouTube's relative API URLs.
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
    const args = Array.prototype.slice.call(arguments);
    const target = new URL(url, 'https://www.youtube.com/tv');
    // An empty document hostname turns ///api/stats/... into https://api/stats/....
    if (target.hostname === 'api' && /^\/stats\/(playback|watchtime|qoe|delayplay|atr|engage)$/.test(target.pathname)) {
        target.hostname = 'www.youtube.com';
        target.pathname = '/api' + target.pathname;
    }
    args[1] = target.href;
    const xhr = this;
    const host = target.hostname;
    const history = target.protocol === 'https:' && host === 'www.youtube.com' && /^\/api\/stats\/(playback|watchtime)$/.test(target.pathname)
        ? { name: target.pathname.split('/').pop(), authorized: false } : null;
    xhr.__legacyHistory = history;
    xhr.__legacyRequest = { method: method, host: host };
    if (!xhr.__legacyListeners) {
        xhr.__legacyListeners = true;
        xhr.addEventListener('load', function () {
            const request = xhr.__legacyRequest, currentHistory = xhr.__legacyHistory;
            if (currentHistory) window.__legacyLog.record('history.result', currentHistory.name + '; HTTP=' + xhr.status + '; authorized=' + currentHistory.authorized);
            else if (xhr.status >= 400) window.__legacyLog.record('http.result', request.method + ' ' + request.host + '; HTTP=' + xhr.status);
        });
        xhr.addEventListener('error', function () {
            const request = xhr.__legacyRequest;
            window.__legacyLog.record('http.error', request.method + ' ' + request.host + '; HTTP=' + xhr.status);
        });
    }
    return open.apply(this, args);
};
const setHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__legacyHistory && String(name).toLowerCase() === 'authorization') this.__legacyHistory.authorized = true;
    return setHeader.apply(this, arguments);
};
const send = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function () {
    const xhr = this, args = arguments, history = xhr.__legacyHistory;
    if (!history || history.authorized || typeof playerAuthorization !== 'function') return send.apply(xhr, args);
    // The native player suppresses this header on a local widget document.
    let authorization;
    try { authorization = playerAuthorization(); }
    catch (error) {
        window.__legacyLog.record('history.auth-error', 'Player authorization callback failed');
        return send.apply(xhr, args);
    }
    Promise.resolve(authorization && (authorization.pendingResult || authorization)).then(function (credentials) {
        if (xhr.readyState !== 1 || xhr.__legacyHistory !== history) return;
        if (credentials && !credentials.signedOut && credentials.token) {
            try {
                setHeader.call(xhr, 'Authorization', 'Bearer ' + credentials.token);
                history.authorized = true;
            } catch (error) {
                window.__legacyLog.record('history.auth-error', 'Player authorization header unavailable');
            }
        }
        return send.apply(xhr, args);
    }, function () {
        if (xhr.readyState !== 1 || xhr.__legacyHistory !== history) return;
        window.__legacyLog.record('history.auth-error', 'Player authorization unavailable');
        return send.apply(xhr, args);
    });
};
// YouTube uses the newer options-object overload; 2016 WebKit accepts a string.
[window].forEach(function (target) {
    const native = target.__legacyNativePostMessage || target.postMessage;
    target.__legacyNativePostMessage = native;
    target.postMessage = function (message, options, transfer) {
        // Adapt the options overload without retaining the frame in its parent.
        const origin = options !== null && typeof options === 'object' ? (options.targetOrigin === undefined ? '*' : options.targetOrigin) : options;
        const args = [message, origin];
        const transfers = options !== null && typeof options === 'object' ? options.transfer : transfer;
        if (transfers) args.push(transfers);
        return native.apply(target, args);
    };
});
