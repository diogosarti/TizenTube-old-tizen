(function () {
    'use strict';
    var origin = location.protocol + '//' + location.host;
    function redirect(value) {
        var url = new URL(String(value), location.href);
        if (url.origin === origin) return url.href;
        if (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') return origin + url.pathname + url.search + url.hash;
        if (/(^|\.)(youtube\.com|ytimg\.com|googlevideo\.com|gstatic\.com|googleapis\.com|googleusercontent\.com|ggpht\.com|google\.com|ajay\.app)$/.test(url.hostname)) {
            return origin + '/__proxy/' + url.protocol.slice(0, -1) + '/' + url.host + url.pathname + url.search + url.hash;
        }
        return url.href;
    }
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        var args = Array.prototype.slice.call(arguments);
        args[1] = redirect(url);
        return open.apply(this, args);
    };
    var fetch = window.fetch;
    window.fetch = function (input, init) {
        if (input instanceof Request) return fetch(new Request(redirect(input.url), input), init);
        return fetch(redirect(input), init);
    };
    var setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (name === 'src' || name === 'poster') value = redirect(value);
        return setAttribute.call(this, name, value);
    };
    [HTMLScriptElement, HTMLImageElement, HTMLMediaElement].forEach(function (constructor) {
        var descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, 'src');
        if (!descriptor || !descriptor.set || !descriptor.configurable) return;
        Object.defineProperty(constructor.prototype, 'src', {
            get: descriptor.get,
            set: function (value) { descriptor.set.call(this, redirect(value)); },
            configurable: true,
            enumerable: descriptor.enumerable
        });
    });
    if (navigator.sendBeacon) {
        var beacon = navigator.sendBeacon;
        navigator.sendBeacon = function (url, data) { return beacon.call(this, redirect(url), data); };
    }
    window.__legacyRedirect = redirect;
}());
