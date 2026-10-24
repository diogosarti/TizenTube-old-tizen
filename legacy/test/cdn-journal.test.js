'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Journal = require('../web/cdn-journal');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
    const values = {};
    let now = 100000;
    const storage = { getItem: k => values[k] || null, setItem(k,v) { values[k] = v; } };
    const create = () => Journal.create(storage, null, () => now);
    return { storage, create, advance(ms = 1) { now += ms; }, time: () => now };
}

test('CDN journal requires distinct repeated failures, expires candidates and resets them after success', () => {
    const env = setup(), j = env.create(), host = 'rr1---sn-example.googlevideo.com';
    assert.equal(j.failure(host,'1.3','tls',1,env.time()),false);
    assert.equal(j.failure(host,'1.3','tls',1,env.time()),false);
    assert.equal(j.read().length,0);
    j.success(host);
    assert.equal(j.failure(host,'1.3','tls',2,env.time()),false);
    env.advance(600001);
    assert.equal(j.failure(host,'1.3','tls',3,env.time()),false);
    env.advance();
    assert.equal(j.failure(host,'1.2','timeout',4,env.time()),true);
    assert.equal(j.summary().count,1);
    assert.equal(j.read()[0].count,2);
    assert.equal(j.read()[0].mode,'1.2');
    assert.equal(j.failure('googlevideo.com.evil.test','1.2','tls',5,env.time()),false);
    assert.equal(j.failure(host,'1.2','HTTP404',5,env.time()),false);
});

test('CDN journal survives recreation and requires repeated failures after deletion', () => {
    const env=setup(), host='rr1---sn-example.googlevideo.com';
    let j=env.create(); j.failure(host,'1.3','tls',1,env.time());env.advance();j.failure(host,'1.3','tls',2,env.time());
    j=env.create();assert.equal(j.summary().count,1);
    const copy=j.read();copy[0].host='modified';assert.equal(j.read()[0].host,host);
    j.remove(host);assert.equal(env.create().read().length,0);
    env.advance();assert.equal(j.failure(host,'1.3','tls',4,env.time()),false);
    env.advance();assert.equal(j.failure(host,'1.3','tls',5,env.time()),true);
    assert.equal(j.summary().count,1);assert.equal(j.read().length,1);
    j.remove(host);assert.equal(env.create().read().length,0);
});

test('CDN journal bounds persisted and candidate spam, evicting the oldest failure first', () => {
    const env=setup(), j=env.create();let id=0;
    function add(n){const h='rr'+n+'---sn-example.googlevideo.com';j.failure(h,'1.3','tls',++id,env.time());env.advance();j.failure(h,'1.3','tls',++id,env.time());env.advance();return h;}
    for(let i=1;i<=50;i++)add(i);
    add(51);
    assert.equal(j.read().length,50);assert.ok(j.read().some(r=>r.host==='rr25---sn-example.googlevideo.com'));
    assert.ok(!j.read().some(r=>r.host==='rr1---sn-example.googlevideo.com'));
    for(let i=52;i<=150;i++)add(i);
    assert.equal(j.read().length,50);assert.equal(env.create().read().length,50);
    for(let i=200;i<300;i++)j.failure('rr'+i+'---sn-example.googlevideo.com','1.3','tls',++id,env.time());
    assert.equal(j.failure('rr200---sn-example.googlevideo.com','1.3','tls',++id,env.time()),false,'Old candidates must be evicted');
    j.clear();assert.equal(env.create().read().length,0);
});

test('CDN storage errors are visible and do not throw into playback', () => {
    const j=Journal.create({getItem(){return '{broken';},setItem(){throw Error('quota');}});
    assert.equal(j.summary().persistent,false);
    j.failure('rr1---sn-example.googlevideo.com','1.3','tls',1,Date.now());
    assert.doesNotThrow(()=>j.failure('rr1---sn-example.googlevideo.com','1.3','tls',2,Date.now()));
    assert.equal(j.summary().count,1);assert.equal(j.summary().persistent,false);
});

test('Full-screen CDN UI preserves long hosts, handles remote navigation and confirms clearing', () => {
    const env=setup(),j=env.create(),host='rr1---sn-example.googlevideo.com';
    const read=j.read;j.read=()=>{const rows=read();rows.find=undefined;return rows;};
    j.failure(host,'1.3','tls',1,env.time());env.advance();j.failure(host,'1.3','tls',2,env.time());
    const listeners={};let focused;
    const document={get activeElement(){return focused;},documentElement:{contains:()=>true},createElement:tag=>new Element(tag)};
    class Element {
        constructor(tag){this.tag=tag;this.children=[];this.style={};this.scrollTop=0;this.offsetTop=0;this.offsetHeight=60;this.clientHeight=500;}
        set textContent(value){this.text=value;this.children=[];}
        get textContent(){return this.text;}
        appendChild(child){child.parentNode=this;this.children.push(child);return child;}
        removeChild(child){this.children=this.children.filter(c=>c!==child);}
        setAttribute(){}
        querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.querySelectorAll(tag)]);}
        querySelector(tag){return this.querySelectorAll(tag)[0];}
        focus(){focused=this;if(this.onfocus)this.onfocus();}
        click(){this.onclick();}
    }
    document.body=new Element('body');const originalFocus=new Element('original');originalFocus.focus();
    const source=fs.readFileSync(path.join(__dirname,'../../mods/ui/cdnUI.js'),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
    const ui=vm.runInNewContext(source+'\n({showCDNs,cdnAction})',{
        parent:{__legacyTLS:{problemCDNs:j,summary:()=>({cdnCollecting:false})}}, t:k=>k,document,
        window:{addEventListener:(type,handler)=>{listeners[type]=handler;},removeEventListener:type=>{delete listeners[type];}}
    });
    const longHost=('a'.repeat(63)+'.').repeat(3)+'b'.repeat(45)+'.googlevideo.com';
    j.failure(longHost,'1.3','tls',3,env.time());env.advance();j.failure(longHost,'1.3','tls',4,env.time());
    ui.showCDNs();let dialog=document.body.children[0];assert.equal(dialog.id,'tt-cdn-journal');
    assert.equal(dialog.querySelectorAll('button')[0].textContent,longHost);
    assert.match(dialog.querySelector('style').textContent,/word-break:break-all/);
    const press=keyCode=>listeners.keydown({type:'keydown',keyCode,preventDefault(){},stopImmediatePropagation(){}});
    press(13);assert.equal(dialog.querySelector('h1').textContent,longHost);
    press(10009);assert.equal(j.read().length,2);
    ui.cdnAction('CDN_DELETE',{host});assert.equal(j.read().length,1);
    ui.cdnAction('CDN_CLEAR_CONFIRM');assert.equal(j.read().length,1);
    press(10009);assert.equal(j.read().length,1,'Return cancels clearing');
    ui.cdnAction('CDN_CLEAR_CONFIRM');press(40);press(13);assert.equal(j.read().length,0);
    press(10009);assert.equal(document.body.children.length,0);assert.equal(focused,originalFocus);assert.equal(Object.keys(listeners).length,0);
});
