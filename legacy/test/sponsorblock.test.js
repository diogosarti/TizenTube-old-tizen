'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('SponsorBlock reports availability without a special timeout or additional requests', async () => {
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
        assert.equal(requests[0].timeout, undefined);
    }
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
    handler.destroy();
    assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
});
