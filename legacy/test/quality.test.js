'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Preferred quality selects the nearest lower resolution, waits for metadata and resets Auto', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/features/preferredVideoQuality.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    let preference = '720p', qualities = [], stateChange, configChange;
    const calls = [];
    const player = {
        addEventListener(type, fn) { stateChange = fn; },
        getPlayerStateObject: () => ({ isPlaying: true }), getVideoData: () => ({ video_id: 'synthetic' }), getVideoStats: () => ({}),
        getAvailableQualityData: () => qualities, setPlaybackQualityRange: (...args) => calls.push(args)
    };
    vm.runInNewContext(source, { window: {}, document: { querySelector: () => player }, clearTimeout() {},
        configRead: () => preference, configChangeEmitter: { addEventListener(type, fn) { configChange = fn; } } });
    assert.deepEqual(calls, [], 'Missing quality metadata must not force highres');
    qualities = [{ quality: 'hd1080', qualityLabel: '1080p' }, { quality: 'large', qualityLabel: '480p' }];
    stateChange(); assert.deepEqual(calls, [['large', 'large']]);
    qualities.push({ quality: 'hd720', qualityLabel: '720p' });
    configChange({ detail: { key: 'preferredVideoQuality' } });
    assert.deepEqual(calls.at(-1), ['hd720', 'hd720']);
    preference = 'auto'; configChange({ detail: { key: 'preferredVideoQuality' } });
    assert.deepEqual(calls.at(-1), ['auto', 'auto']);
    const count = calls.length; stateChange(); configChange({ detail: { key: 'preferredVideoQuality' } });
    assert.equal(calls.length, count, 'Auto must not repeatedly override player adaptation');
});

test('Codec default matches the settings key and preserves an explicit saved preference', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/config.js'), 'utf8').replace(/^export /gm, '');
    for (const saved of [{}, { preferredVideoCodec: 'vp9' }]) {
        const read = vm.runInNewContext(source + '\nconfigRead;', { window: { localStorage: { 'ytaf-configuration': JSON.stringify(saved) } }, console: { warn() {} } });
        assert.equal(read('preferredVideoCodec'), saved.preferredVideoCodec || 'any');
    }
});
