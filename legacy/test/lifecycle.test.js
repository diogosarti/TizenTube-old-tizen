'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=name=>fs.readFileSync(path.join(__dirname,'../../mods',name),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');

test('Player discovery is shared, rebinds on media events and stops polling after discovery',()=>{
    let currentPlayer={},currentVideo={};const events={},calls=[[],[]];
    const watch=vm.runInNewContext(source('utils/playerLifecycle.js')+'\nwatchPlayer;',{
        document:{querySelector:s=>s==='video'?currentVideo:currentPlayer,addEventListener(type,fn){events[type]=fn;}},window:{addEventListener(){}},
        clearTimeout(){},setTimeout(){throw Error('No polling after discovery');}
    });
    watch((p,v)=>calls[0].push([p,v]));watch((p,v)=>calls[1].push([p,v]));assert.equal(calls[0].length,1);assert.equal(calls[1].length,1);
    currentPlayer={};currentVideo={};events.canplay();events.playing();assert.equal(calls[0].length,2);assert.equal(calls[1].length,2);
    currentPlayer=currentVideo=null;events.emptied();assert.equal(calls[0].at(-1)[0],null);
    currentPlayer={};events.playing();assert.equal(calls[0].at(-1)[0],currentPlayer);
});

test('Queue remembers nested IDs and cancels stale, duplicate and replaced-player transitions',()=>{
    const timers=new Map(),commands=[],events={};let timerID=0,watch,id='B',ended=false;
    function player(){return{listeners:new Set(),addEventListener(type,fn){this.listeners.add(fn);},removeEventListener(type,fn){this.listeners.delete(fn);},
        getVideoData:()=>({video_id:id}),getPlayerStateObject:()=>({isEnded:ended,isPlaying:!ended})};}
    const window={addEventListener(type,fn){events[type]=fn;}};
    const cardID=vm.runInNewContext(source('utils/videoCards.js')+'\ngetQueuedVideoId;');
    vm.runInNewContext(source('features/videoQueuing.js'),{window,watchPlayer(fn){watch=fn;},getQueuedVideoId:cardID,resolveCommand:c=>commands.push(c),
        document:{getElementById:()=>null},setTimeout(fn){timers.set(++timerID,fn);return timerID;},clearTimeout(id){timers.delete(id);}});
    const a=player(),b=player();watch(a,{});
    const cards=['A','B','C'].map(contentId=>({tileRenderer:{contentId,onSelectCommand:{watchEndpoint:{videoId:contentId}}}}));
    cards[2]={lockupViewModel:{contentId:'C',rendererContext:{commandContext:{onTap:{innertubeCommand:{watchEndpoint:{videoId:'C'}}}}}}};
    cards.forEach(c=>window.queuedVideos.add(c));a.listeners.forEach(fn=>fn());assert.equal(window.queuedVideos.lastVideoId,'B');
    id='X';ended=true;a.listeners.forEach(fn=>fn());a.listeners.forEach(fn=>fn());assert.equal(timers.size,1);
    const fire=()=>{const [key,fn]=timers.entries().next().value;timers.delete(key);fn();};fire();assert.equal(commands[0].watchEndpoint.videoId,'C');
    id='A';a.listeners.forEach(fn=>fn());window.queuedVideos.clear();assert.equal(timers.size,0);assert.equal(window.queuedVideos.lastVideoId,null);
    cards.forEach(c=>window.queuedVideos.add(c));a.listeners.forEach(fn=>fn());events.hashchange();assert.equal(timers.size,0);
    a.listeners.forEach(fn=>fn());watch(b,{});assert.equal(a.listeners.size,0);assert.equal(b.listeners.size,1);assert.equal(timers.size,1);
    id='manual';fire();assert.equal(commands.length,1,'A pending transition cannot replace a manually selected video');
});

test('Saved playback speed is applied to each current video without listeners on obsolete videos',()=>{
    const events={};let current={playbackRate:1};
    const text=source('ui/speedUI.js').replace(/export\s*\{[^}]+\}/g,'');
    vm.runInNewContext(text,{document:{querySelector:()=>current,addEventListener(type,fn){events[type]=fn;}},configRead:()=>1.5});
    const first=current;events.canplay({target:first});assert.equal(first.playbackRate,1.5);
    current={playbackRate:1};events.canplay({target:current});assert.equal(current.playbackRate,1.5);
    first.playbackRate=1;events.canplay({target:first});assert.equal(first.playbackRate,1);
});
