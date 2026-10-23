'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('SponsorBlock bounds availability checking without additional requests', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/features/sponsorblock.js'), 'utf8');
    const handlerSource = source.slice(source.indexOf('class SponsorBlockHandler'), source.indexOf('// When this global'));
    for (const scenario of [
        { reply: 404, availability: 'available' },
        { reply: 'timeout', availability: 'unavailable' },
        { reply: 'error', availability: 'unavailable' }
    ]) {
        const requests = [];
        class XHR {
            open() {}
            send() {
                const reply = scenario.reply;
                requests.push(this);
                queueMicrotask(() => {
                    if (reply === 'timeout') this.ontimeout();
                    else if (reply === 'error') this.onerror();
                    else { this.status = reply; this.onload(); }
                });
            }
        }
        const Handler = vm.runInNewContext(handlerSource + '\nSponsorBlockHandler;', {
            XMLHttpRequest: XHR, sha256: () => 'abcd', sponsorblockAPI: 'https://example.test/api',
            window: { __legacyDirect: true },
            console: { info() {} }
        });
        const handler = new Handler('synthetic');
        await handler.init().catch(() => {});
        assert.equal(handler.availability, scenario.availability);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].timeout, 10000);
    }
});

test('SponsorBlock cancels an unfinished segment request when leaving the video', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/features/sponsorblock.js'), 'utf8');
    let request, aborted = 0;
    class XHR {
        open() {}
        send() { request = this; }
        abort() { aborted++; this.onabort(); this.onloadend(); }
    }
    const Handler = vm.runInNewContext(source.slice(source.indexOf('class SponsorBlockHandler'), source.indexOf('// When this global')) + '\nSponsorBlockHandler;', {
        XMLHttpRequest: XHR, sha256: () => 'abcd', sponsorblockAPI: 'https://example.test/api',
        window: {}, console: { info() {} }, clearTimeout() {}
    });
    const handler = new Handler('synthetic');
    const pending = handler.init();
    assert.equal(handler.segmentRequest, request);
    handler.destroy();
    await pending;
    assert.equal(aborted, 1);
    assert.equal(handler.segmentRequest, null);
    assert.equal(handler.active, false);
    assert.equal(handler.segments, null);
});

test('SponsorBlock schedules only one overlay retry and cancels it when the video changes', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/features/sponsorblock.js'), 'utf8');
    const timers = new Map(); let id = 0, queries = 0;
    const Handler = vm.runInNewContext(source.slice(source.indexOf('class SponsorBlockHandler'), source.indexOf('// When this global')) + '\nSponsorBlockHandler;', {
        document: {querySelector() { queries++; return null; }}, console: {info(){}}, window: {removeEventListener(){}},
        setTimeout(fn) { timers.set(++id,fn); return id; }, clearTimeout(id) { timers.delete(id); }
    });
    const handler = new Handler('synthetic');
    handler.video = {duration:100, removeEventListener(){}};
    handler.buildOverlay(); handler.buildOverlay();
    assert.equal(timers.size,1); assert.equal(queries,1);
    const delayed = timers.values().next().value;
    handler.destroy(); assert.equal(timers.size,0);
    delayed(); assert.equal(timers.size,0,'A callback from a previous video must not restart polling');
});

test('SponsorBlock waits for playback to reach the segment and reschedules for playback state and speed', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/features/sponsorblock.js'), 'utf8');
    const timers = new Map(), listeners = new Map(), seeks = []; let id = 0;
    const video = { currentTime: 100, duration: 600, paused: false, seeking: false, readyState: 4, playbackRate: 1,
        addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
    const Handler = vm.runInNewContext(source.slice(source.indexOf('class SponsorBlockHandler'), source.indexOf('// When this global')) + '\nSponsorBlockHandler;', {
        window: { __legacyDirect: true }, console: { info() {} }, configRead: () => false, barTypes: { sponsor: { name: 'sponsor' } },
        document: { querySelector: selector => selector === 'video' ? video : { seekTo: target => seeks.push(target) } },
        setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(key) { timers.delete(key); }
    });
    const handler = new Handler('synthetic');
    handler.segments = [{ segment: [105, 120], category: 'sponsor', UUID: 'synthetic' }];
    handler.skippableCategories = ['sponsor'];
    handler.scheduleSkipHandler = () => handler.scheduleSkip();
    handler.attachVideo();
    function fireTimer() {
        const [key, timer] = timers.entries().next().value;
        timers.delete(key); timer.fn();
    }
    handler.scheduleSkip();
    assert.equal(timers.values().next().value.delay, 5000);
    fireTimer(); // The media clock did not advance while the timer elapsed.
    assert.deepEqual(seeks, [], 'An elapsed wall-clock timer must not skip unwatched content');
    video.readyState = 2; listeners.get('waiting')();
    assert.equal(timers.size, 0, 'Buffering must cancel the scheduled skip');
    video.readyState = 4; listeners.get('playing')();
    video.playbackRate = 0.5; listeners.get('ratechange')();
    assert.equal(timers.values().next().value.delay, 10000);
    video.currentTime = 102.5; fireTimer();
    assert.deepEqual(seeks, []);
    assert.equal(timers.values().next().value.delay, 5000);
    video.currentTime = 130; fireTimer();
    assert.deepEqual(seeks, [], 'A delayed callback must not seek back into an already passed segment');
    video.currentTime = 104; video.seeking = true; listeners.get('seeking')();
    assert.equal(timers.size, 0);
    video.seeking = false; listeners.get('seeked')();
    video.currentTime = 105; fireTimer();
    assert.deepEqual(seeks, [120], 'Skip only after reaching the segment');
    video.currentTime = 110;
    handler.segments[0].UUID = 'late-synthetic';
    handler.scheduleSkip();
    assert.equal(timers.values().next().value.delay, 0);
    fireTimer();
    assert.deepEqual(seeks, [120, 120], 'Late data or resume inside a segment must still skip');
    handler.destroy();
    assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
});

test('Manual SponsorBlock prompt uses late segments and ignores keys after leaving the video', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/features/sponsorblock.js'), 'utf8');
    let keyHandler, removed = false;
    const button = { style: {}, remove() { removed = true; } }, seeks = [];
    const Handler = vm.runInNewContext(source.slice(source.indexOf('class SponsorBlockHandler'), source.indexOf('// When this global')) + '\nSponsorBlockHandler;', {
        window: { __legacyDirect: true }, t: value => value, clearTimeout() {}, console: { info() {} },
        document: { createElement: () => button, body: { appendChild() {} },
            addEventListener(type, fn) { keyHandler = fn; }, removeEventListener() {},
            querySelector: selector => selector === '.html5-video-player' ? { seekTo: target => seeks.push(target) } : null }
    });
    const handler = new Handler('synthetic');
    handler.video = { currentTime: 12, duration: 100, removeEventListener() {} };
    handler.skippableCategories = ['intro']; handler.manualSkippableCategories = ['intro'];
    handler.installManualSkip();
    assert.equal(button.style.display, 'none');
    handler.segments = [{ category: 'intro', segment: [10, 30] }];
    handler.updateManualSkip();
    assert.equal(button.style.display, 'block');
    const event = { keyCode: 405, preventDefault() {}, stopImmediatePropagation() {} };
    keyHandler(event); assert.deepEqual(seeks, [30]);
    handler.destroy(); keyHandler(event);
    assert.deepEqual(seeks, [30]); assert.equal(removed, true);
});

test('Watched filtering honors its switch and handles both video card formats', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/features/adblock.js'), 'utf8');
    const config = { enableHideWatchedVideos: false, hideWatchedVideosPages: ['home'], hideWatchedVideosThreshold: 80 };
    const hide = vm.runInNewContext(source.slice(source.indexOf('function hideVideo(items)')) + '\nhideVideo;', {
        configRead: key => config[key], location: { hash: '#/' }
    });
    const cards = [
        { tileRenderer: { header: { tileHeaderRenderer: { thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 95 } }] } } } },
        { lockupViewModel: { contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: 95 } } } }] } } } },
        { other: true }
    ];
    assert.equal(hide(cards), cards);
    config.enableHideWatchedVideos = true;
    assert.deepEqual(Array.from(hide(cards)), [cards[2]]);
});
