'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('Subtitle language uses selected UI language and works without Intl.Locale',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../../mods/features/moreSubtitles.js'),'utf8');
    const text=source.slice(source.indexOf('const LANGUAGE_CODES'),source.indexOf('let isPatched')).replace(/^export /gm,'');
    const window={yt:{config_:{HL:'ru-RU'}}};const api=vm.runInNewContext(text+'\n({country:getCountryLanguage,user:getUserLanguage});',{
        window,navigator:{language:'en-US'},Intl:{},getUserCountryCode:()=> 'DE',languages:{language:{standard:{long:{ru:'Russian',de:'German',en:'English'}}}},console:{warn(){}}
    });
    assert.equal(api.country('RU').code,'ru');assert.equal(api.country('DE').code,'de');assert.equal(api.user().code,'ru');
    window.yt.config_.HL='unknown';assert.equal(api.user().code,'de');assert.equal(api.country('ZZ'),null);
});
