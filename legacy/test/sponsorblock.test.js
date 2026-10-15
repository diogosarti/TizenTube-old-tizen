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
