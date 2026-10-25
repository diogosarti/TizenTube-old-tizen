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
    vm.runInNewContext(source, { window: {}, watchPlayer: fn => fn(player), clearTimeout() {},
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

test('TLS settings default to Auto and retain every explicit mode', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../mods/config.js'), 'utf8').replace(/^export /gm, '');
    for (const saved of [{}, { tlsMode: 'auto' }, { tlsMode: '1.2' }, { tlsMode: '1.3' }, { tlsMode: 'invalid' }]) {
        const storage = { 'ytaf-configuration': JSON.stringify(saved) };
        const read = vm.runInNewContext(source + '\nconfigRead;', { window: { localStorage: storage }, console: { warn() {} } });
        const expected = ['auto', '1.2', '1.3'].includes(saved.tlsMode) ? saved.tlsMode : 'auto';
        assert.equal(read('tlsMode'), expected);
        assert.equal(JSON.parse(storage['ytaf-configuration']).tlsMode, expected);
        assert.equal(read('extendedDiagnostics'), false);
    }
});

test('Settings recover invalid storage shapes and apply live changes when persistence fails', () => {
    const source=fs.readFileSync(path.join(__dirname,'../../mods/config.js'),'utf8').replace(/^export /gm,'');
    for(const stored of [null,[],7,{enableSponsorBlock:'false',videoSpeed:null,sponsorBlockManualSkips:'intro'},
        {videoSpeed:-1,speedSettingsIncrement:-1,sidebarContentsOrder:[null,{},'valid',{browseId:'custom',title:'Custom'}]}]) {
        const api=vm.runInNewContext(source+'\n({read:configRead,defaults:defaultConfig});',{
            window:{localStorage:{'ytaf-configuration':JSON.stringify(stored)}},console:{warn(){}}
        });
        assert.equal(api.read('enableSponsorBlock'),true);assert.equal(api.read('videoSpeed'),1);
        assert.ok(api.read('speedSettingsIncrement')>0);assert.ok(!api.read('sidebarContentsOrder').includes(null));
        api.read('sponsorBlockManualSkips').push('synthetic');
        assert.ok(!api.defaults.sponsorBlockManualSkips.includes('synthetic'));
    }
    let applied,changes=0,errors=0;
    const storage={};Object.defineProperty(storage,'ytaf-configuration',{get:()=>'{"tlsMode":"auto"}',set(){throw Error('QuotaExceededError');}});
    const api=vm.runInNewContext(source+'\n({read:configRead,write:configWrite,events:configChangeEmitter});',{
        window:{__legacyDirect:true,localStorage:storage},parent:{__legacyTLS:{setMode(value){applied=value;}}},
        console:{warn(){},info(){}},setTimeout(fn){fn();},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options&&options.detail;}}
    });
    api.events.addEventListener('configChange',()=>changes++);api.events.addEventListener('configStorageError',()=>errors++);
    assert.doesNotThrow(()=>api.write('tlsMode','1.2'));assert.equal(applied,'1.2');assert.equal(api.read('tlsMode'),'1.2');assert.equal(changes,1);
    api.write('tlsMode','auto');assert.equal(changes,2);assert.equal(errors,1,'Persistent storage failure must not flood notifications');
});

test('Quality detaches the old player and reapplies to replaced player or video', () => {
    const source=fs.readFileSync(path.join(__dirname,'../../mods/features/preferredVideoQuality.js'),'utf8').replace(/^import[^\n]*\n/gm,'');
    let watch,configChange,preference='720p';
    function player(){return {listeners:new Set(),calls:[],addEventListener(type,fn){this.listeners.add(fn);},removeEventListener(type,fn){this.listeners.delete(fn);},
        getPlayerStateObject:()=>({isPlaying:true}),getVideoData:()=>({video_id:'synthetic'}),getVideoStats:()=>({}),
        getAvailableQualityData:()=>[{quality:'hd720',qualityLabel:'720p'},{quality:'large',qualityLabel:'480p'}],setPlaybackQualityRange(...args){this.calls.push(args);}};}
    vm.runInNewContext(source,{window:{},watchPlayer(fn){watch=fn;},configRead:()=>preference,configChangeEmitter:{addEventListener(type,fn){configChange=fn;}}});
    const a=player(),b=player();watch(a,{});watch(b,{});
    assert.equal(a.listeners.size,0);assert.equal(b.listeners.size,1);
    preference='480p';configChange({detail:{key:'preferredVideoQuality'}});
    assert.equal(a.calls.length,1);assert.deepEqual(b.calls.at(-1),['large','large']);
    watch(b,{});assert.equal(b.listeners.size,1);assert.equal(b.calls.length,3,'Replacing only the video must reapply the preference');
});
