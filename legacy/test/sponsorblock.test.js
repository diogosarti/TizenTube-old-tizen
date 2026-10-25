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
    handler.matchesPlayback = () => true;
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

test('SponsorBlock does not repeat a seek rounded to an earlier keyframe and rearms after rewinding', () => {
    const source=fs.readFileSync(path.join(__dirname,'../../mods/features/sponsorblock.js'),'utf8');
    const timers=new Map(),seeks=[];let id=0,now=10000;
    const video={currentTime:165,duration:600,paused:false,seeking:false,readyState:4,playbackRate:1};
    const Handler=vm.runInNewContext(source.slice(source.indexOf('class SponsorBlockHandler'),source.indexOf('// When this global'))+'\nSponsorBlockHandler;',{
        window:{__legacyDirect:true},console:{info(){}},Date:{now:()=>now},configRead:()=>false,barTypes:{sponsor:{name:'sponsor'}},
        document:{querySelector:()=>({seekTo(target){seeks.push(target);video.seeking=true;}})},
        setTimeout(fn,delay){timers.set(++id,{fn,delay});return id;},clearTimeout(key){timers.delete(key);}
    });
    const handler=new Handler('synthetic');handler.video=video;
    handler.matchesPlayback=()=>true;
    handler.segments=[{segment:[160,224.268],category:'sponsor',UUID:'rounded'}];handler.skippableCategories=['sponsor'];
    function fire(){const [key,timer]=timers.entries().next().value;timers.delete(key);timer.fn();}
    handler.scheduleSkip();fire();assert.deepEqual(seeks,[224.268]);
    video.currentTime=220.1;video.seeking=false;handler.scheduleSkip({type:'seeked'});
    for(const time of [220.2,221,222,223]){now+=1000;video.currentTime=time;handler.scheduleSkip({type:'timeupdate'});assert.equal(timers.size,0);}
    assert.deepEqual(seeks,[224.268],'Let the rounded tail play instead of repeatedly seeking back to the same keyframe');
    video.currentTime=224.5;handler.scheduleSkip({type:'timeupdate'});assert.equal(handler.pendingAutoSkip,null);
    now+=5000;video.currentTime=170;handler.scheduleSkip({type:'seeked'});fire();assert.deepEqual(seeks,[224.268,224.268]);
});

test('SponsorBlock rebinds a replaced video without duplicate listeners or another segment request', async () => {
    const source=fs.readFileSync(path.join(__dirname,'../../mods/features/sponsorblock.js'),'utf8');
    function video(){return {currentTime:230,duration:600,paused:false,seeking:false,readyState:4,playbackRate:1,listeners:new Map(),
        addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type){this.listeners.delete(type);}};}
    const first=video(),second=video(),documentListeners=new Map();let current=first,requests=0;
    const Handler=vm.runInNewContext(source.slice(source.indexOf('class SponsorBlockHandler'),source.indexOf('// When this global'))+'\nSponsorBlockHandler;',{
        window:{addEventListener(){},removeEventListener(){}},console:{info(){}},sha256:()=> 'abcd',sponsorblockAPI:'https://example.test',
        URL,location:{hash:'#/watch?v=synthetic'},
        configRead:()=>[],document:{baseURI:'https://example.test/',querySelector:selector=>selector==='video'?current:null,addEventListener(type,fn){documentListeners.set(type,fn);},removeEventListener(type){documentListeners.delete(type);}},
        clearTimeout(){},setTimeout(){throw Error('No extra polling is needed');}
    });
    const handler=new Handler('synthetic');
    handler.requestSegments=async()=>{requests++;return [{videoID:'synthetic',segments:[{segment:[160,224.268],category:'sponsor',UUID:'synthetic'}]}];};
    handler.getSkippableCategories=()=>['sponsor'];handler.installManualSkip=()=>{};handler.buildOverlay=()=>{};
    await handler.init();assert.equal(first.listeners.size,9);assert.equal(documentListeners.size,2);
    current=second;documentListeners.get('loadedmetadata')({type:'loadedmetadata',target:second});
    assert.equal(handler.video,second);assert.equal(first.listeners.size,0);assert.equal(second.listeners.size,9);
    documentListeners.get('loadedmetadata')({type:'loadedmetadata',target:second});assert.equal(second.listeners.size,9);
    // A retained callback must not adopt a homepage preview from another video.
    handler.matchesPlayback=()=>false;
    current=video();documentListeners.get('playing')({type:'playing',target:current});
    assert.equal(handler.video,second);assert.equal(current.listeners.size,0);
    assert.equal(requests,1);handler.destroy();assert.equal(second.listeners.size,0);assert.equal(documentListeners.size,0);
});

test('SponsorBlock navigation destroys the handler on exit but preserves matching PiP playback', () => {
    const source=fs.readFileSync(path.join(__dirname,'../../mods/features/sponsorblock.js'),'utf8');
    let navigation,destroyed=0,playingID='synthetic';
    const context={URL,location:{hash:'#/watch?v=synthetic'},configRead:()=>true,
        window:{addEventListener(type,fn){navigation=fn;},removeEventListener(){}},
        document:{baseURI:'https://example.test/',querySelector:()=>({getVideoData:()=>({video_id:playingID})})},
        console:{info(){},warn(){}},clearTimeout(){}};
    vm.createContext(context);
    const classEnd=source.indexOf('// When this global');
    vm.runInContext(source.slice(source.indexOf('class SponsorBlockHandler'),classEnd)+
        '\nSponsorBlockHandler.prototype.init=async function(){};\nconst originalDestroy=SponsorBlockHandler.prototype.destroy;\n'+
        'SponsorBlockHandler.prototype.destroy=function(){countDestroy();return originalDestroy.call(this);};',
        Object.assign(context,{countDestroy(){destroyed++;}}));
    vm.runInContext(source.slice(classEnd),context);
    const first=context.window.sponsorblock;
    context.location.hash='#/';navigation();assert.equal(destroyed,1);assert.equal(context.window.sponsorblock,null);assert.equal(first.active,false);
    navigation();assert.equal(destroyed,1);
    context.location.hash='#/watch?v=synthetic';navigation();const pip=context.window.sponsorblock;
    context.window.isPipPlaying=true;context.location.hash='#/';navigation();assert.equal(context.window.sponsorblock,pip);
    playingID='other-preview';navigation();assert.equal(context.window.sponsorblock,null);assert.equal(destroyed,2);
});

test('SponsorBlock keeps one timer while timeupdate media and wall clocks advance together', () => {
    const source=fs.readFileSync(path.join(__dirname,'../../mods/features/sponsorblock.js'),'utf8');
    let now=10000,created=0;const timers=new Map();
    const Handler=vm.runInNewContext(source.slice(source.indexOf('class SponsorBlockHandler'),source.indexOf('// When this global'))+'\nSponsorBlockHandler;',{
        window:{},console:{info(){}},Date:{now:()=>now},
        setTimeout(fn,delay){timers.set(++created,{fn,delay});return created;},clearTimeout(id){timers.delete(id);}
    });
    const handler=new Handler('synthetic');handler.video={currentTime:100,paused:false,seeking:false,readyState:4,playbackRate:1};
    handler.segments=[{segment:[200,220],category:'sponsor',UUID:'future'}];handler.skippableCategories=['sponsor'];
    handler.scheduleSkip();
    for(let i=0;i<200;i++){now+=10;handler.video.currentTime+=0.01;handler.scheduleSkip({type:'timeupdate'});}
    assert.equal(created,1);assert.equal(timers.size,1);
    handler.video.readyState=2;handler.scheduleSkip({type:'waiting'});assert.equal(timers.size,0);
    handler.video.readyState=4;handler.scheduleSkip({type:'playing'});assert.equal(created,2);
    now+=2000;handler.scheduleSkip({type:'timeupdate'});assert.equal(created,3,'A stopped media clock must move the deadline');
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
