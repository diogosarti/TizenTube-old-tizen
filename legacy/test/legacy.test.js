'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { once } = require('node:events');
const Logger = require('../web/logger');
const proxy = require('../proxy');
const { createServer } = require('../service');

test('Seek preview uses HTTPS without mutating shared frames and shows signed time from the seek origin', () => {
    const frame = { url: 'file://i.ytimg.com/sb/synthetic/storyboard.jpg', width: 100, height: 50 };
    function Storyboard() { this.props = { seekTime: 90 }; }
    Storyboard.prototype.getStoryboardFrame = function () { const position = this.props.seekTime; return frame; };
    Object.defineProperty(Storyboard.prototype, 'timeLabel', { configurable: true, get() {
        return Math.floor(this.props.seekTime / 60) + ':' + String(this.props.seekTime % 60).padStart(2, '0');
    } });
    const instance = new Storyboard(), video = { currentTime: 80 };
    const thumb = { style: { backgroundImage: 'url("' + frame.url + '")' } }, label = {};
    const element = { __instance: instance, querySelector: selector => selector.includes('storyboard-thumb') ? thumb : label };
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/seekPreview.js'), 'utf8');
    vm.runInNewContext(source, { window: { __legacyDirect: true },
        document: { readyState: 'complete', querySelector: selector => selector === 'video' ? video : element } });
    assert.equal(instance.getStoryboardFrame().url, 'https://i.ytimg.com/sb/synthetic/storyboard.jpg');
    assert.equal(frame.url, 'file://i.ytimg.com/sb/synthetic/storyboard.jpg');
    assert.equal(label.textContent, '1:30 (+0:10)');
    assert.match(thumb.style.backgroundImage, /^url\("https:/);
    instance.props.seekTime = 65;
    assert.equal(instance.timeLabel, '1:05 (\u22120:15)');
    video.currentTime = 90; instance.props.seekTime = 170;
    assert.equal(instance.timeLabel, '2:50 (+1:20)', 'A new seek uses the newly committed playback position');
    frame.url = 'https://i.ytimg.com/sb/synthetic/storyboard.jpg';
    assert.equal(instance.getStoryboardFrame(), frame, 'An HTTPS frame is already valid');
});

test('Player actions preserve constructor identity and native listeners when patched after mount', () => {
    const parser = fs.readFileSync(path.resolve(__dirname, '../../mods/utils/ASTParser.js'), 'utf8')
        .replace(/^import[^\n]*\n/gm, '').replace('export function', 'function');
    const extractAssignedFunctions = vm.runInNewContext(parser + '\nextractAssignedFunctions;', {
        esprima: require('../../mods/node_modules/esprima'), estraverse: require('../../mods/node_modules/estraverse')
    });
    function NativeActions(props) {
        this.props = props;
        this.on = (type, listener) => this.listeners.push(listener);
        this.listeners = [];
        this.keyHandler = function () {};
        this.promoted = function () { return 'TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION'; };
        this.openSettings = function () { this.popup = 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS'; };
        this.settings = function () {
            const type = 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS';
            return function () { return this.props.data.settingActions; };
        }();
        this.engagement = function () { return this.props.data.engagementActions; };
    }
    NativeActions.prototype.mount = function () { this.on('keydown', this.keyHandler); };
    const props = () => ({ data: { settingActions: [{ type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS' }], engagementActions: [] } });
    const existing = new NativeActions(props()); existing.mount();
    const popup = existing.openSettings;
    const window = { _yttv: { actions: NativeActions } };
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/customUI.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    vm.runInNewContext(source, {
        window,
        document: { readyState: 'complete', querySelectorAll: () => [{ __instance: existing }] },
        configRead: key => ['enablePatchingVideoPlayer', 'enableMPButton', 'enableSpeedControlsButton', 'enableSuperThanksButton', 'enableAIAskButton'].includes(key),
        extractAssignedFunctions, ButtonRenderer: (_toggle, _text, icon) => ({ icon }), t: key => key
    });
    assert.equal(window._yttv.actions, NativeActions, 'Patching must keep the component constructor registered by YouTube');
    assert.equal(existing.openSettings, popup, 'The settings popup action must not be mistaken for the settings button list');
    assert.equal(existing.listeners.length, 1, 'Patching a mounted component must not mount a replacement');
    assert.equal(existing.settings().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP').length, 1);
    assert.equal(existing.settings().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP').length, 1);
    const next = new NativeActions(props()); next.mount();
    assert.equal(next.constructor, NativeActions);
    assert.equal(next.listeners.length, 1);
    assert.equal(next.settings().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP').length, 1);
    assert.equal(next.engagement().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED').length, 1);
    assert.equal(next.engagement().find(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED').button.buttonRenderer.icon, 'SPEEDOMETER');
});

test('Playback settings route both speed icons to the custom menu and preserve unrelated actions', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/resolveCommand.js'), 'utf8')
        .replace(/^import[^\n]*\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '');
    let forwarded;
    const window = { _yttv: { app: { instance: { resolveCommand(cmd) { forwarded = cmd; return 'native'; } } } } };
    vm.runInNewContext(source + '\npatchResolveCommand();', { window, t: key => key, buttonItem: () => ({ injected: true }) });
    const items = ['SLOW_MOTION_VIDEO', 'SPEEDOMETER', 'SETTINGS'].map(iconType => ({ compactLinkRenderer: {
        icon: { iconType }, subtitle: { simpleText: 'Original' }, serviceEndpoint: { original: true }
    } }));
    const renderers = items.map(item => item.compactLinkRenderer);
    const cmd = { openPopupAction: { uniqueId: 'playback-settings', popup: { overlaySectionRenderer: { overlay: {
        overlayTwoPanelRenderer: { actionPanel: { overlayPanelRenderer: { content: { overlayPanelItemListRenderer: { items } } } } }
    } } } } };
    assert.equal(window._yttv.app.instance.resolveCommand(cmd), 'native');
    assert.equal(forwarded, cmd);
    for (const renderer of renderers.slice(0, 2)) {
        assert.equal(renderer.serviceEndpoint.signalAction.customAction.action, 'TT_SPEED_SETTINGS_SHOW');
        assert.equal(renderer.subtitle.simpleText, 'player.withTizenTube');
    }
    assert.deepEqual(renderers[2].serviceEndpoint, { original: true });
});

test('Guide JSON hook accepts unrelated values and preserves unknown guide entries', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/customGuideAction.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    const context = vm.createContext({ configRead: key => key === 'sidebarContentsOrder' ? ['known'] : false,
        configWrite() {}, configChangeEmitter: { addEventListener() {} } });
    vm.runInContext(source, context);
    for (const json of ['null','{"items":[]}','{"items":[{}]}','[1,2]']) {
        assert.equal(vm.runInContext('JSON.stringify(JSON.parse(' + JSON.stringify(json) + '))',context),json);
    }
    const input = {items:[{guideSectionRenderer:{items:[
        {guideEntryRenderer:{navigationEndpoint:{browseEndpoint:{browseId:'known'}}}},
        {guideEntryRenderer:{navigationEndpoint:{custom:'synthetic'}}}
    ]}}]};
    const result = vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(input)) + ')',context);
    assert.equal(result.items[0].guideSectionRenderer.items.length,2);
});

test('DeArrow updates video cards, deduplicates and caches branding, and cancels pending navigation work', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/features/adblock.js'), 'utf8');
    const requests = []; let enabled = true, now = 1000, navigation;
    const deArrowify = vm.runInNewContext(source.slice(source.indexOf('const brandingCache'), source.indexOf('function hqify(')) + '\ndeArrowify;', {
        configRead: () => enabled,
        Date: { now: () => now }, window: { addEventListener(type, fn) { navigation = fn; } },
        XMLHttpRequest: function () {
            this.open = (method, url) => { this.url = url; };
            this.send = () => { requests.push(this); };
            this.abort = () => { this.aborted = true; this.onabort(); };
        }
    });
    const tile = { tileRenderer: { style: 'TILE_STYLE_YTLR_DEFAULT', contentId: 'synthetic-tile',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'Original' } } }, header: { tileHeaderRenderer: { thumbnail: { thumbnails: [] } } } } };
    const lockup = { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'synthetic-lockup',
        metadata: { lockupMetadataViewModel: { title: { content: 'Original' } } }, contentImage: { thumbnailViewModel: { image: { sources: [] } } } } };
    const items = [{ adSlotRenderer: {} }, { adSlotRenderer: {} }, tile, lockup,
        { tileRenderer: { style: 'TILE_STYLE_YTLR_CHANNEL' } }, { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } }];
    deArrowify(items);
    deArrowify(items);
    assert.equal(requests.length, 2, 'Identical pending video IDs must share one request');
    for (const xhr of requests) {
        xhr.status = 200; xhr.response = { titles: [{ title: 'Revised title', votes: 2 }], thumbnails: [{ timestamp: 15, votes: 3 }] };
        xhr.onload();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(items.length, 4, 'Consecutive ad slots must still be removed');
    assert.equal(tile.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Revised title');
    assert.equal(lockup.lockupViewModel.metadata.lockupMetadataViewModel.title.content, 'Revised title');
    assert.match(tile.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url, /videoID=synthetic-tile&time=15$/);
    assert.match(lockup.lockupViewModel.contentImage.thumbnailViewModel.image.sources[0].url, /videoID=synthetic-lockup&time=15$/);
    deArrowify(items); assert.equal(requests.length, 2, 'Fresh cached branding must not start another request');
    enabled = false; deArrowify(items);
    assert.equal(requests.length, 2, 'Disabled DeArrow must not issue requests');
    enabled = true; now += 300001; deArrowify(items);
    assert.equal(requests.length, 4, 'Expired entries must be requested again');
    navigation();
    assert.ok(requests.slice(2).every(xhr => xhr.aborted), 'Navigation must abort all pending branding requests');
    await new Promise(resolve => setImmediate(resolve));
});

test('early module initialization handles fresh and malformed YouTube profiles', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/disableWhosWatching.js'), 'utf8').replace(/^import[^\n]*\n/, '');
    const context = { localStorage: {}, configRead: () => false, configChangeEmitter: { addEventListener() {} } };
    vm.runInNewContext(source, context);
    const key = 'yt.leanback.default::recurring_actions';
    context.localStorage[key] = JSON.stringify({ data: { data: { whos_watching_fullscreen_zero_accounts: { lastFired: 0 } } } });
    vm.runInNewContext(source, { ...context });
    assert.ok(JSON.parse(context.localStorage[key]).data.data.whos_watching_fullscreen_zero_accounts.lastFired > Date.now());
    for (const stored of ['{', 'null', '{}', '{"data":{}}', '{"data":{"data":{}}}']) {
        for (const enabled of [false, true]) {
            vm.runInNewContext(source, { ...context, localStorage: { [key]: stored }, configRead: () => enabled,
                setInterval() {}, clearInterval() {} });
        }
    }
});

test('memory log stays bounded and removes sensitive diagnostic values', () => {
    const log = Logger.create(3);
    log.record('error', 'Failed https://example.com/?token=synthetic-secret user@example.com');
    log.record('error', 'C:\\Users\\Synthetic\\test.js 10.0.0.8');
    log.record('error', 'Authorization: Bearer synthetic-secret');
    const result = JSON.stringify(log.read());
    assert.doesNotMatch(result, /synthetic-secret|user@example|Synthetic|10\.0\.0\.8/);
    assert.doesNotThrow(() => Logger.create(3, () => { throw new Error('diagnostic callback'); }).record('ready', 'ok'));
    log.record('ready', 'ok');
    assert.equal(log.read().length, 3);
    assert.equal(log.read()[0].n, 2);
});

test('local playback pings use current-account authorization only on YouTube HTTPS', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/legacyDirectBootstrap.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    function XHR() { this.headers = {}; this.listeners = {}; this.listenerCounts = {}; }
    XHR.prototype.open = function (method, url) { this.url = url; this.readyState = 1; };
    XHR.prototype.setRequestHeader = function (name, value) { this.headers[name] = value; };
    XHR.prototype.send = function () { this.sent = true; };
    const log = Logger.create(20);
    const messages = [];
    const window = { __legacyLog: log, postMessage(...args) { messages.push(args); } };
    vm.runInNewContext(source, { window, parent: window, XMLHttpRequest: XHR, URL, Promise });
    window.postMessage('test', null);
    window.postMessage('test', { targetOrigin: '*', transfer: ['synthetic'] });
    assert.equal(messages[0][1], null);
    assert.equal(messages[1][1], '*');
    assert.equal(messages[1][2][0], 'synthetic');
    const application = window.yt.player.Application;
    application.create = function () { return 'created'; };
    let account = { token: 'synthetic-current-account' };
    assert.equal(application.create(null, null, null, () => account), 'created');
    XHR.prototype.addEventListener = function (name, listener) { this.listeners[name] = listener; this.listenerCounts[name] = (this.listenerCounts[name] || 0) + 1; };
    function request(url) {
        const xhr = new XHR(); xhr.open('GET', url); xhr.send(); return xhr;
    }
    const playback = request('///api/stats/watchtime?synthetic=1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(playback.url, 'https://www.youtube.com/api/stats/watchtime?synthetic=1');
    assert.equal(playback.headers.Authorization, 'Bearer synthetic-current-account');
    assert.equal(playback.sent, true);
    playback.status = 204; playback.listeners.load();
    assert.ok(log.read().some(entry => entry.code === 'history.result' && entry.detail.includes('authorized=true')));
    assert.doesNotMatch(JSON.stringify(log.read()), /synthetic-current-account/);

    for (const url of ['https://www.youtube.com.example.com/api/stats/watchtime', 'http://www.youtube.com/api/stats/watchtime', 'https://www.youtube.com/api/stats/qoe']) {
        const other = request(url);
        assert.equal(other.sent, true);
        assert.equal(other.headers.Authorization, undefined);
    }
    const existing = new XHR(); existing.open('GET', 'https://www.youtube.com/api/stats/playback');
    existing.setRequestHeader('Authorization', 'Bearer synthetic-original'); existing.send();
    assert.equal(existing.headers.Authorization, 'Bearer synthetic-original');
    assert.equal(existing.sent, true);

    account = { signedOut: true };
    const signedOut = request('https://www.youtube.com/api/stats/watchtime');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signedOut.sent, true);
    assert.equal(signedOut.headers.Authorization, undefined);

    let resolveToken;
    account = { pendingResult: new Promise(resolve => { resolveToken = resolve; }) };
    const aborted = request('https://www.youtube.com/api/stats/watchtime');
    aborted.readyState = 0;
    resolveToken({ token: 'synthetic-later' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted.sent, undefined);
    assert.equal(aborted.headers.Authorization, undefined);
    for (const result of [() => undefined, () => null, () => ({ pendingResult: Promise.resolve(undefined) }), () => ({ pendingResult: Promise.reject(new Error('unavailable')) })]) {
        account = result();
        const empty = request('https://www.youtube.com/api/stats/watchtime');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(empty.sent, true);
        assert.equal(empty.headers.Authorization, undefined);
    }
    account = { pendingResult: Promise.resolve({ token: 'synthetic-later' }) };
    const reopened = request('https://www.youtube.com/api/stats/watchtime');
    reopened.open('GET', 'https://example.com/other');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reopened.sent, undefined);
    assert.equal(reopened.headers.Authorization, undefined);
    assert.equal(reopened.listenerCounts.load, 1);
    assert.equal(reopened.listenerCounts.error, 1);
});

test('widget starts with mods and keeps baseline playback in diagnostics', () => {
    const requests = [];
    const elements = {};
    let panelWrites = 0;
    let navigation;
    for (const id of ['player', 'setup', 'connect', 'baseline', 'options', 'status', 'feedback', 'feedback-text', 'busy-spinner']) {
        elements[id] = { style: {}, focus() {}, removeAttribute(name) { delete this[name]; } };
    }
    elements.log = { style: {}, set textContent(value) { panelWrites++; } };
    let frameHtml;
    elements.player.contentWindow = { document: { open() {}, write(html) { frameHtml = html; }, close() {} } };
    function XHR() { requests.push(this); }
    XHR.prototype.open = function (method, url) { this.url = url; };
    XHR.prototype.send = function () {};
    XHR.prototype.abort = function () { this.aborted = true; };
    const context = {
        window: {}, location: { href: 'file:///index.html' }, XMLHttpRequest: XHR, LegacyLogger: Logger,
        LegacyTLS: { create: () => ({ install() {} }) },
        document: { getElementById: id => elements[id], addEventListener() {} },
        setTimeout: (callback, delay) => { if (delay === 0) navigation = callback; return 1; }, clearTimeout() {}
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../widget/widget.js'), 'utf8'), context);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://www.youtube.com/tv');
    assert.equal(elements.options.style.display, 'none');
    requests[0].status = 200;
    requests[0].responseText = '<html><head></head><body></body></html>';
    requests[0].onload();
    assert.equal(elements.player.src, 'file:///player.html');
    elements.player.onload();
    assert.equal(elements.player.onload, null);
    assert.match(frameHtml, /userScript\.js/);
    assert.match(frameHtml, /lazy-debug-watermark/);
    assert.equal(elements.setup.style.display, 'none');
    assert.equal(panelWrites, 0);
    assert.equal(elements.feedback.style.display, 'block');
    context.window.__legacyStatus('', elements.player.contentWindow);
    assert.equal(elements.feedback.style.display, 'none');
    context.window.__legacyCommand(406);
    assert.equal(elements.options.style.display, 'block');
    elements.baseline.onclick();
    requests[1].status = 200;
    requests[1].responseText = requests[0].responseText;
    requests[1].onload();
    elements.player.onload();
    assert.doesNotMatch(frameHtml, /userScript\.js/);
    context.window.__legacyCommand(406);
    elements.connect.onclick();
    requests[2].onerror();
    assert.equal(elements.options.style.display, 'block');
    assert.equal(elements.setup.style.display, 'block');
    elements.connect.onclick();
    requests[3].status = 200; requests[3].responseText = requests[0].responseText;
    requests[3].onload(); elements.player.onload();
    context.window.__legacyFrameNavigation({});
    assert.equal(navigation, undefined);
    context.window.__legacyFrameNavigation(elements.player.contentWindow);
    assert.equal(elements.setup.style.display, 'block');
    navigation();
    assert.equal(requests.length, 5);
    assert.ok(context.window.__legacyLog.read().some(entry => entry.code === 'page.navigation'));
    navigation = undefined;
    context.window.__legacyFrameNavigation(elements.player.contentWindow);
    assert.equal(navigation, undefined);
});

test('SponsorBlock initializes in a local document and treats missing segments as normal', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/features/sponsorblock.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    const listeners = {};
    const video = { duration: 10, currentTime: 0, paused: false, readyState: 4, playbackRate: 1, addEventListener() {}, removeEventListener() {} };
    const timers = [];
    const seeks = [];
    const player = { seekTo: (target, allowSeekAhead) => seeks.push([target, allowSeekAhead]) };
    const intervals = [];
    let mutations;
    function element() {
        return {
            style: { values: {}, setProperty(key, value) { this.values[key] = value; } },
            classList: { add() {}, contains: () => true }, children: [],
            appendChild(child) { this.children.push(child); }, remove() {},
            getBoundingClientRect: () => ({ height: 9, top: 0, bottom: 9 }),
            getAttribute: () => 'false'
        };
    }
    const slider = element();
    const container = element();
    const log = Logger.create(20);
    const requests = [];
    const location = { href: 'file:///player.html#/watch?v=abcdefghijk', hash: '#/watch?v=abcdefghijk' };
    const context = {
        window: { __legacyDirect: true, __legacyLog: log, addEventListener: (type, fn) => { listeners[type] = fn; } },
        document: {
            baseURI: 'https://www.youtube.com/tv', createElement: element,
            querySelector: selector => ({ video, '.html5-video-player': player, 'div[idomkey="slider"]': slider, 'ytlr-progress-bar': slider, 'ytlr-redux-connect-ytlr-progress-bar': container })[selector] || null
        },
        location, URL, t: key => key, sha256: () => '1234', showToast() {},
        configRead: key => key === 'sponsorBlockManualSkips' ? [] : true,
        console: { info() {}, warn() {} }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
        setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
        MutationObserver: function (fn) { mutations = fn; this.observe = () => {}; this.disconnect = () => {}; },
        XMLHttpRequest: function () {
            this.open = (method, url) => { requests.push(url); };
            this.send = () => {
                this.status = requests.length === 2 ? 404 : 200;
                this.responseText = this.status === 404 ? '' : JSON.stringify([{ videoID: 'abcdefghijk', segments: [{ category: 'sponsor', segment: [1, 3], UUID: 'synthetic' }] }]);
                this.onload();
            };
        }
    };
    vm.runInNewContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(context.window.sponsorblock.segments.length, 1);
    assert.equal(context.window.sponsorblock.video, video);
    intervals[0]();
    const overlay = context.window.sponsorblock.segmentsoverlay;
    mutations([{ removedNodes: [] }]);
    assert.notEqual(overlay.style.values.display, 'none');
    assert.ok(container.children.includes(overlay));
    context.window.sponsorblock.scheduleSkip();
    video.currentTime = 1;
    timers.pop()();
    assert.deepEqual(seeks, [[3, true]]);
    assert.equal(video.currentTime, 1);
    listeners.hashchange();
    assert.equal(requests.length, 1);
    location.hash = '#/watch?v=lmnopqrstuv';
    listeners.hashchange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.ok(log.read().some(entry => entry.code === 'sponsor.empty'));
    assert.ok(!log.read().some(entry => entry.code === 'sponsor.error'));
});

test('proxy rewrites plain and escaped URLs and rejects other destinations', () => {
    const origin = 'http://localhost:8124';
    assert.equal(proxy.rewrite('https://www.youtube.com/tv', origin), origin + '/tv');
    assert.equal(proxy.rewrite('"//i.ytimg.com/image.jpg"', origin), '"' + origin + '/__proxy/https/i.ytimg.com/image.jpg"');
    const input = JSON.stringify({ url: 'https://r1.googlevideo.com/videoplayback?x=1' }).replace(/\//g, '\\/');
    assert.equal(JSON.parse(proxy.rewrite(input, origin)).url, origin + '/__proxy/https/r1.googlevideo.com/videoplayback?x=1');
    assert.equal(proxy.targetFor('/__proxy/https/i.ytimg.com/a?x=1').hostname, 'i.ytimg.com');
    assert.throws(() => proxy.targetFor('/__proxy/http/127.0.0.1/private'));
    assert.throws(() => proxy.targetFor('/__proxy/https/youtube.com.example.com/private'));
    assert.throws(() => proxy.targetFor('/__proxy/https/user:secret@youtube.com/private'));
    const html = '<html><head><script>boot()</script></head><body>content</body></html>';
    const modified = proxy.html(html, origin, true);
    assert.ok(modified.indexOf('frame.js') < modified.indexOf('boot()'));
    assert.match(modified, /<body><script src="\/__legacy\/userScript.js"/);
    assert.doesNotMatch(proxy.html(html, origin, false), /userScript\.js/);
});

test('historical service serves diagnostics and redacts incoming logs without disk writes', async t => {
    const server = createServer(path.resolve(__dirname, '../web'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    function request(route, body) {
        return new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: body ? 'POST' : 'GET' }, res => {
                let text = ''; res.setEncoding('utf8'); res.on('data', data => { text += data; });
                res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
            });
            req.on('error', reject); req.end(body);
        });
    }
    const health = await request('/__legacy/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).version, '0.1.0');
    const script = await request('/__legacy/logger.js');
    assert.equal(script.status, 200); assert.ok(script.text.length > 1000);
    await request('/__legacy/log', JSON.stringify({ code: 'page.error', detail: 'token=synthetic-secret' }));
    const logs = await request('/__legacy/logs');
    assert.equal(logs.headers['cache-control'], 'no-store');
    assert.match(logs.text, /page.error/); assert.doesNotMatch(logs.text, /synthetic-secret/);
    assert.equal((await request('/__proxy/http/127.0.0.1/private')).status, 403);
});


test('frame reserves diagnostic keys on every event and leaves green for settings', () => {
    const listeners = {}, commands = [];
    const document = { addEventListener(type, fn) { listeners[type] = fn; } };
    const window = { addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../web/frame.js'), 'utf8'), {
        window, document, parent: { __legacyLog: Logger.create(20), __legacyCommand: key => commands.push(key) }, LegacyLogger: Logger
    });
    for (const type of ['keydown', 'keypress', 'keyup']) {
        let blocked = false, prevented = false;
        listeners[type]({ type, keyCode: 49, preventDefault() { prevented = true; }, stopImmediatePropagation() { blocked = true; } });
        assert.equal(blocked, true); assert.equal(prevented, true);
        listeners[type]({ type, keyCode: 404, preventDefault() { assert.fail('green was reserved'); }, stopImmediatePropagation() { assert.fail('green was blocked'); } });
    }
    assert.deepEqual(commands, [49]);
});

test('loading feedback follows media events and visible spinners', () => {
    const events = {}, mediaEvents = {}, statuses = [], ticks = [];
    const spinner = { nodeType: 1, parentNode: null, getBoundingClientRect: () => ({ width: 50, height: 50 }) };
    let spinnerVisible = false;
    let removed = 0, now = 1000;
    const video = { currentTime: 0, buffered: { length: 0 }, addEventListener: (type, fn) => {
        if (!mediaEvents[type]) mediaEvents[type] = [];
        mediaEvents[type].push(fn);
    }, removeEventListener(type, fn) { removed++; mediaEvents[type] = mediaEvents[type].filter(f => f !== fn); } };
    let currentVideo = video;
    const log = Logger.create(20);
    function fire(type) { mediaEvents[type].forEach(fn => fn()); }
    const window = { addEventListener: (type, fn) => { events[type] = fn; }, getComputedStyle: () => ({ display: spinnerVisible ? 'block' : 'none', visibility: 'visible', opacity: '1' }) };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../web/frame.js'), 'utf8'), {
        window, parent: { __legacyLog: log, __legacyStatus: text => statuses.push(text) }, LegacyLogger: Logger,
        Date: { now: () => now },
        document: { addEventListener() {}, querySelector: () => currentVideo, querySelectorAll: () => [spinner] },
        MutationObserver: function () { this.disconnect = () => {}; },
        setInterval: fn => ticks.push(fn), setTimeout() {}
    });
    events.DOMContentLoaded();
    assert.equal(statuses.at(-1), '');
    fire('loadstart');
    assert.equal(statuses.at(-1), 'Loading video…');
    fire('waiting');
    assert.equal(statuses.at(-1), 'Buffering…');
    fire('seeking');
    assert.equal(statuses.at(-1), 'Seeking…');
    fire('seeked');
    assert.equal(statuses.at(-1), '');
    spinnerVisible = true; ticks[0]();
    assert.equal(statuses.at(-1), 'Loading…');
    spinnerVisible = false; ticks[0]();
    assert.equal(statuses.at(-1), '');
    currentVideo = { ...video, currentTime: 12, paused: false, readyState: 4 };
    ticks[0]();
    assert.ok(removed >= 10, 'Replacing video must detach listeners from the previous element');
    fire('waiting');
    assert.equal(statuses.at(-1), 'Buffering…');
    assert.ok(log.read().some(entry => entry.code === 'video.waiting' && /time=12\.0/.test(entry.detail)));
    now += 1500; ticks[0]();
    assert.ok(log.read().some(entry => entry.code === 'video.loop-delay' && /lateMs=1000/.test(entry.detail)));
});

test('Stall diagnostics distinguish track buffers, bound followups and detach on video replacement', () => {
    const events = {}, ticks = [], log = Logger.create(100);
    let now = 1000, ranges = { lab: '0.000-30.000', lvb: '0.000-9.000,12.000-20.000', private: 'not for logging' };
    function media() {
        const listeners = {};
        return { currentTime: 10, playbackRate: 1, readyState: 2, networkState: 2, buffered: { length: 0 },
            paused: false, seeking: false, error: { code: 3 },
            getVideoPlaybackQuality: () => ({ totalVideoFrames: 120, droppedVideoFrames: 2 }),
            addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
            removeEventListener(type, fn) { listeners[type] = listeners[type].filter(f => f !== fn); },
            fire(type) { (listeners[type] || []).slice().forEach(fn => fn()); }
        };
    }
    let video = media();
    const window = { addEventListener: (type, fn) => { events[type] = fn; } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../web/frame.js'), 'utf8'), {
        window, parent: { __legacyLog: log, __legacyStatus() {}, __legacyTLS: { summary: () => ({ active: 2, queued: 1, errors: 4, completed: 7, bytes: 1024 }) } },
        LegacyLogger: Logger, Date: { now: () => now },
        document: { addEventListener() {}, querySelector: selector => selector === 'video' ? video : { getVideoStats: () => ranges }, querySelectorAll: () => [] },
        setInterval: fn => ticks.push(fn), setTimeout() {}
    });
    events.DOMContentLoaded();
    video.fire('waiting'); video.fire('stalled');
    const tracks = () => log.read().filter(e => e.code === 'video.stall-tracks');
    assert.equal(tracks().length, 1, 'Adjacent media events share one track snapshot');
    assert.match(tracks()[0].detail, /audioAhead=20\.0; videoAhead=0\.0/);
    assert.match(tracks()[0].detail, /mediaError=3; trackErrors=unknown; decoded=120; dropped=2/);
    assert.match(log.read().find(e => e.code === 'video.stall-network').detail, /transportErrors=4/);
    ranges = { lab: 'unavailable', lvb: '0.0-25.0' };
    video.fire('playing');
    for (let i = 0; i < 7; i++) { now += 1000; ticks[0](); }
    assert.equal(tracks().length, 6, 'Exactly five followups, including after playback resumes');
    assert.match(tracks().at(-1).detail, /audioAhead=unknown; videoAhead=15\.0/);
    const old = video;
    video.fire('waiting'); video = media(); ticks[0]();
    const count = tracks().length;
    old.fire('stalled'); now += 1000; ticks[0]();
    assert.equal(tracks().length, count, 'Replacing video cancels old followups and event listeners');
    ranges = null; video.fire('stalled');
    assert.match(tracks().at(-1).detail, /audioAhead=unknown; videoAhead=unknown/);
    assert.doesNotMatch(JSON.stringify(log.read()), /not for logging/);
});

test('spatial key handler uses frame mode when parent has no navigation API', () => {
    const acorn = require('acorn');
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/spatial-navigation-polyfill.js'), 'utf8');
    let callback;
    function visit(node) {
        if (!node || !node.type) return;
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'addEventListener' && node.arguments[0].value === 'keydown') callback = node.arguments[1];
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && value.type) visit(value);
        }
    }
    visit(acorn.parse(source, { ecmaVersion: 'latest' }));
    let direction;
    const handler = vm.runInNewContext('(' + source.slice(callback.start, callback.end) + ')', {
        parent: {}, window: { __spatialNavigation__: { keyMode: 'ARROW' } }, document: { activeElement: { nodeName: 'DIV' } },
        ARROW_KEY_CODE: { 39: 'right' }, TAB_KEY_CODE: 9, Map, navigate: dir => { direction = dir; }
    });
    handler({ keyCode: 13 });
    handler({ keyCode: 39, preventDefault() {} });
    assert.equal(direction, 'right');
});


test('numeric seeking uses the legacy player once per key press', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/ui.js'), 'utf8');
    const start = source.indexOf('var eventHandler = ') + 'var eventHandler = '.length;
    const callback = require('acorn').parseExpressionAt(source, start, { ecmaVersion: 'latest' });
    const seeks = [], video = { duration: 100, currentTime: 50 };
    const window = { __legacyDirect: true };
    const handler = vm.runInNewContext('(' + source.slice(callback.start, callback.end) + ')', {
        window, keys: { 51: 3 }, configRead: () => false, console: { info() {} },
        document: { getElementById() {}, querySelector: selector => selector === 'video' ? video : { seekTo: time => seeks.push(time) } }
    });
    for (const type of ['keydown', 'keypress', 'keyup']) handler({ type, keyCode: 51 });
    assert.deepEqual(seeks, [30]);
    assert.equal(video.currentTime, 50);
    window.__legacyDirect = false;
    handler({ type: 'keydown', keyCode: 51 });
    assert.equal(video.currentTime, 30);
});
