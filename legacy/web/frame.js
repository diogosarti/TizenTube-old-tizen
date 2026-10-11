(function () {
    'use strict';
    function report(entry) {
        if (parent !== window) {
            parent.__legacyLog.record(entry.code, entry.detail);
        }
    }
    var log = LegacyLogger.create(300, report);
    window.__legacyLog = log;
    window.addEventListener('error', function (event) {
        if (event.target !== window) return;
        var source = event.filename;
        log.record('page.error', event.message + ' script=' + (source ? source.split('?')[0].split('/').pop() : 'inline') + ' line=' + event.lineno + ' column=' + event.colno);
    });
    window.addEventListener('unhandledrejection', function (event) {
        log.record('promise.error', event.reason && event.reason.message ? event.reason.message : 'Unhandled rejection');
        if (event.reason && event.reason.stack) log.record('promise.stack', event.reason.stack);
    });
    window.addEventListener('error', function (event) {
        if (event.target && event.target !== window) log.record('resource.error', event.target.tagName || 'unknown');
    }, true);
    function diagnosticKey(event) {
        var key = event.keyCode;
        if (key === 403 || key === 406 || key === 49 || key === 50 || key === 52) {
            if (parent !== window) {
                if (event.type === 'keydown') parent.__legacyCommand(key);
                event.preventDefault(); event.stopImmediatePropagation();
            }
        }
    }
    ['keydown', 'keypress', 'keyup'].forEach(function (type) { document.addEventListener(type, diagnosticKey, true); });
    window.addEventListener('beforeunload', function () {
        if (parent !== window) parent.__legacyFrameNavigation(window);
    });
    log.record('page.start', 'fetch=' + typeof window.fetch + '; Promise=' + typeof window.Promise + '; MSE=' + !!(window.MediaSource || window.WebKitMediaSource));
    window.addEventListener('DOMContentLoaded', function () {
        log.record('page.dom', 'DOM ready; video=' + !!document.querySelector('video'));
        var video = document.querySelector('video');
        var mediaStatus = '';
        function updateStatus() {
            if (video && /^https?:/i.test(video.currentSrc || '') && parent.__legacyTLS) parent.__legacyTLS.system('video');
            var text = mediaStatus;
            if (!text) {
                var spinners = document.querySelectorAll('yt-spinner');
                for (var i = 0; i < spinners.length; i++) {
                    var element = spinners[i], rect = element.getBoundingClientRect();
                    if (!rect.width || !rect.height) continue;
                    var shown = true;
                    for (var node = element; node && node.nodeType === 1; node = node.parentNode) {
                        var style = window.getComputedStyle(node);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') { shown = false; break; }
                    }
                    if (shown) { text = 'Loading…'; break; }
                }
            }
            if (parent !== window) parent.__legacyStatus(text, window, text !== 'Unable to play video');
        }
        setInterval(updateStatus, 500);
        var observer = new MutationObserver(function () {
            if (!video) { video = document.querySelector('video'); if (video) attach(video); }
        });
        function attach(element) {
            observer.disconnect();
            ['loadstart', 'waiting', 'stalled', 'seeking', 'playing', 'canplay', 'seeked', 'emptied', 'ended', 'error'].forEach(function (type) {
                element.addEventListener(type, function () {
                    if (type === 'loadstart') mediaStatus = 'Loading video…';
                    else if (type === 'waiting' || type === 'stalled') mediaStatus = 'Buffering…';
                    else if (type === 'seeking') mediaStatus = 'Seeking…';
                    else if (type === 'error') mediaStatus = 'Unable to play video';
                    else mediaStatus = '';
                    updateStatus();
                });
            });
            function state() {
                var ahead = 0;
                for (var i = 0; i < element.buffered.length; i++) {
                    if (element.buffered.start(i) <= element.currentTime && element.buffered.end(i) >= element.currentTime) {
                        ahead = element.buffered.end(i) - element.currentTime; break;
                    }
                }
                return 'ready=' + element.readyState + '; network=' + element.networkState +
                    '; time=' + element.currentTime.toFixed(1) + '; buffer=' + ahead.toFixed(1) +
                    '; size=' + element.videoWidth + 'x' + element.videoHeight +
                    '; decoded=' + element.webkitDecodedFrameCount + '; dropped=' + element.webkitDroppedFrameCount +
                    '; error=' + (element.error ? element.error.code : 0);
            }
            ['loadedmetadata', 'playing', 'waiting', 'stalled', 'ended', 'error'].forEach(function (type) {
                element.addEventListener(type, function () {
                    log.record('video.' + type, state());
                });
            });
            setInterval(function () {
                if (!element.paused && !element.ended) log.record('video.sample', state());
            }, 10000);
            log.record('video.attached', 'Media events enabled');
        }
        if (video) attach(video);
        else observer.observe(document.body, { childList: true, subtree: true });
        updateStatus();
        setTimeout(function () {
            log.record('page.check', 'video=' + !!document.querySelector('video') + '; yttv=' + !!window._yttv);
        }, 20000);
    });
}());
