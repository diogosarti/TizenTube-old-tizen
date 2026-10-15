// Custom UI for video player

import { extractAssignedFunctions } from "../utils/ASTParser.js";
import { configRead } from "../config.js";
import { ButtonRenderer } from "./ytUI.js";
import { t } from 'i18next';

// Show request results alongside the player's controls without extra network checks.
if (window.__legacyDirect && parent.__legacyTLS) {
    setInterval(() => {
        const controls = document.querySelector('ytlr-player-actions-container');
        let badge = document.querySelector('.tt-media-transport');
        if (!controls) {
            if (badge) badge.style.display = 'none';
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tt-media-transport';
            badge.style.cssText = 'position:fixed;right:36px;top:36px;z-index:10000;padding:8px 14px;background:rgba(0,0,0,.75);color:white;font-size:26px;border-radius:6px;pointer-events:none;white-space:pre;';
            document.body.appendChild(badge);
        }
        const state = parent.__legacyTLS.summary();
        const label = value => value === 'unknown' ? t('legacyNetwork.unknown') : value;
        const lines = [];
        if (configRead('showPlayerProtocol')) {
            lines.push(t('legacyNetwork.playerVideo', { transport: label(state.video) }));
            if (state.audio && state.audio !== 'unknown' && state.audio !== state.video) {
                lines[0] += ' · ' + t('legacyNetwork.playerAudio', { transport: label(state.audio) });
            }
        }
        const display = configRead('sponsorBlockStatusDisplay');
        const availability = !configRead('enableSponsorBlock') ? 'disabled' :
            window.sponsorblock ? window.sponsorblock.availability : 'checking';
        if (display === 'always' || (display === 'unavailable' && availability === 'unavailable')) {
            lines.push(t('legacyNetwork.sponsorStatus.' + availability));
        }
        const text = lines.join('\n');
        if (badge.textContent !== text) badge.textContent = text;
        const style = window.getComputedStyle(controls);
        const displayStyle = !lines.length || controls.classList.contains('zylon-hidden') || style.display === 'none' ||
            style.visibility === 'hidden' || +style.opacity < 0.5 ? 'none' : 'block';
        if (badge.style.display !== displayStyle) badge.style.display = displayStyle;
    }, 500);
}

let patchAttempts = 0;
let playerPatched = false;
function applyPatches() {
    if (playerPatched) return;
    if (++patchAttempts > 240) {
        if (window.__legacyLog) window.__legacyLog.record('player.patch', 'Player controls pattern unavailable');
        return;
    }
    if (!window._yttv) return setTimeout(applyPatches, 250);
    const methods = Object.keys(window._yttv).filter(key => {
        return typeof window._yttv[key] === 'function' && window._yttv[key].toString().includes('TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION');
    });

    if (methods.length === 0) {
        setTimeout(applyPatches, 250);
        return;
    }

    const origMethod = window._yttv[methods[0]];
    const source = origMethod.toString();
    let functions;
    try { functions = extractAssignedFunctions(source); }
    catch (_) {
        if (window.__legacyLog) window.__legacyLog.record('player.patch', 'Player controls source unsupported');
        return;
    }
    function member(match) {
        const fn = functions.find(match);
        return fn && fn.left ? fn.left.split('.')[1] : null;
    }
    const settingActionGroup = member(func => func.rhs.includes('TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS') && /return\s+function\b/.test(func.rhs));
    const previousButtonName = member(func => func.rhs.includes('skipNextButton') && func.rhs.indexOf('skipPreviousButton') > func.rhs.indexOf('skipNextButton'));
    const nextButtonName = member(func => func.rhs.includes('skipPreviousButton') && func.rhs.indexOf('skipNextButton') > func.rhs.indexOf('skipPreviousButton'));
    const engagementActionButton = member(func => func.rhs.includes('props.data.engagementActions'));
    const mountMethod = Object.getOwnPropertyNames(origMethod.prototype).find(name => {
        const method = Object.getOwnPropertyDescriptor(origMethod.prototype, name).value;
        return typeof method === 'function' && /this\.on\(["']keydown["']/.test(method.toString());
    });
    if (!settingActionGroup || !engagementActionButton || !mountMethod) return;

    function patchPlayerActions(inst) {
        if (inst.__ttPlayerActionsPatched) return inst;
        inst.__ttPlayerActionsPatched = true;
        const pipCommand = {
            "type": "TRANSPORT_CONTROLS_BUTTON_TYPE_PIP",
            "button": {
                "buttonRenderer": ButtonRenderer(
                    false,
                    configRead('enableSwapMPWithPIP') ? t('player.pictureInPicture') : t('player.miniPlayer'),
                    'CLEAR_COOKIES',
                    {
                        customAction: {
                            action: configRead('enableSwapMPWithPIP') ? 'ENTER_PIP' : 'ENTER_MP',
                        }
                    }
                )
            }
        }


        const origSettingActionGroup = inst[settingActionGroup];
        if (configRead('enableMPButton')) {
            inst[settingActionGroup] = function () {
                const res = origSettingActionGroup.apply(this, arguments);
                const idx = res.findIndex(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS');
                res.find(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP') || res.splice(idx, 0, pipCommand);
                return res;
            };
        }

        if (engagementActionButton && configRead('enableSpeedControlsButton')) {
            const origEngagementActionButton = inst[engagementActionButton];
            inst[engagementActionButton] = function () {
                const res = origEngagementActionButton.apply(this, arguments);
                res.find(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED') || res.push({
                    type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED',
                    button: {
                        buttonRenderer: ButtonRenderer(
                            false,
                            t('player.playbackSpeed.button'),
                            'SLOW_MOTION_VIDEO',
                            {
                                customAction:
                                {
                                    action: 'TT_SPEED_SETTINGS_SHOW',
                                }
                            }
                        )
                    }
                });
                return res;
            }
        }

        if (!configRead('enableSuperThanksButton')) {
            const origEngagementActionButton = inst[engagementActionButton];
            inst[engagementActionButton] = function () {
                const res = origEngagementActionButton.apply(this, arguments);
                const superThanksFiltered = res.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SUPER_THANKS');
                const shoppingFiltered = superThanksFiltered.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SHOPPING');
                return shoppingFiltered;
            }
        }
        
        if (!configRead('enableAIAskButton')) {
            const origEngagementActionButton = inst[engagementActionButton];
            inst[engagementActionButton] = function () {
                const res = origEngagementActionButton.apply(this, arguments);
                const superThanksFiltered = res.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_YOUCHAT_BUTTON');
                const shoppingFiltered = superThanksFiltered.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_YOUCHAT_BUTTON');
                return shoppingFiltered;
            }
        }

        if (configRead('enablePreviousNextButtons')) {
            if (!previousButtonName || !nextButtonName) return inst;
            inst[previousButtonName] = function () {
                return ButtonRenderer(
                    false,
                    t('player.previous'),
                    'SKIP_PREVIOUS',
                    {
                        signalAction: {
                            signal: 'PLAYER_PLAY_PREVIOUS'
                        }
                    }
                )
            }

            inst[nextButtonName] = function () {
                return ButtonRenderer(
                    false,
                    t('player.next'),
                    'SKIP_NEXT',
                    {
                        signalAction: {
                            signal: 'PLAYER_PLAY_NEXT'
                        }
                    }
                )
            }

        }

        return inst;
    }

    if (configRead('enablePatchingVideoPlayer')) {
        // Keep YouTube's constructor identity so it can reuse and dispose its component.
        const origMount = origMethod.prototype[mountMethod];
        origMethod.prototype[mountMethod] = function () {
            patchPlayerActions(this);
            return origMount.apply(this, arguments);
        };
        playerPatched = true;
        // A lazy-loaded constructor may already have mounted before the pattern was found.
        Array.prototype.forEach.call(document.querySelectorAll('ytlr-player-actions-container'), element => {
            const inst = element.__instance;
            if (inst instanceof origMethod) patchPlayerActions(inst);
        });
    }
}


if (document.readyState === 'complete' || document.readyState === 'interactive') {
    applyPatches();
} else {
    window.addEventListener('DOMContentLoaded', applyPatches);
}
