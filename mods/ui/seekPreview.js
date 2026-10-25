// YouTube's storyboard service inherits the local widget's file: protocol.
if (window.__legacyDirect) {
    function startSeekPreview() {
        let observer;
        let stopTimer;
        function install() {
            const element = document.querySelector('ytlr-storyboard');
            const instance = element && element.__instance;
            if (!instance) return false;
            const prototype = Object.getPrototypeOf(instance);
            const originalFrame = prototype.getStoryboardFrame;
            const timeLabel = Object.getOwnPropertyDescriptor(prototype, 'timeLabel');
            const target = typeof originalFrame === 'function' && originalFrame.toString().match(/this\.props\.([\w$]+)/);
            if (!target || !timeLabel || !timeLabel.get) {
                if (window.__legacyLog) window.__legacyLog.record('seek.preview', 'Storyboard pattern unavailable');
                return true;
            }
            prototype.getStoryboardFrame = function () {
                const frame = originalFrame.apply(this, arguments);
                if (frame && /^file:\/\/i\.ytimg\.com\/sb\//i.test(frame.url)) {
                    return Object.assign({}, frame, { url: frame.url.replace(/^file:/i, 'https:') });
                }
                return frame;
            };
            Object.defineProperty(prototype, 'timeLabel', Object.assign({}, timeLabel, {
                get: function () {
                    const label = timeLabel.get.call(this);
                    const video = document.querySelector('video');
                    const position = this.props[target[1]];
                    if (!video || !Number.isFinite(position)) return label;
                    // The native player holds currentTime at the seek origin until confirmation.
                    const delta = Math.round(position - video.currentTime);
                    const seconds = Math.abs(delta);
                    const minutes = Math.floor(seconds / 60);
                    return label + ' (' + (delta < 0 ? '\u2212' : '+') + minutes + ':' + String(seconds % 60).padStart(2, '0') + ')';
                }
            }));
            // The first render may have happened before this observer ran.
            const thumb = element.querySelector('[idomkey="storyboard-thumb"]');
            if (thumb) thumb.style.backgroundImage = thumb.style.backgroundImage.replace(/file:\/\/i\.ytimg\.com\/sb\//gi, 'https://i.ytimg.com/sb/');
            const label = element.querySelector('[idomkey="time-label"]');
            if (label) label.textContent = instance.timeLabel;
            if (window.__legacyLog) window.__legacyLog.record('seek.preview', 'HTTPS storyboard and relative seek time enabled');
            return true;
        }
        if (install()) return;
        function stopWatching() {
            if (observer) observer.disconnect();
            observer = null;
            clearTimeout(stopTimer);
        }
        function trySeek(event) {
            if (![37, 39, 412, 417].includes(event.keyCode)) return;
            if (install()) {
                stopWatching();
                document.removeEventListener('keydown', trySeek, true);
                return;
            }
            if (observer) return;
            const player = document.querySelector('ytlr-player');
            if (!player) return;
            observer = new MutationObserver(() => {
                if (install()) {
                    stopWatching();
                    document.removeEventListener('keydown', trySeek, true);
                }
            });
            observer.observe(player, { childList: true, subtree: true });
            stopTimer = setTimeout(stopWatching, 5000);
        }
        document.addEventListener('keydown', trySeek, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startSeekPreview);
    else startSeekPreview();
}
