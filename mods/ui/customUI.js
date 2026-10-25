// Custom UI for video player

import { extractAssignedFunctions } from "../utils/ASTParser.js";
import { configRead } from "../config.js";
import { ButtonRenderer, showToast } from "./ytUI.js";
import { t } from 'i18next';

function alignPlayerShortcuts(controls) {
    const buttons = Array.from(controls.querySelectorAll('yt-button-container'));
    const positions = [];
    function renderer(button) {
        while (button && button.tagName !== 'YTLR-BUTTON-RENDERER') button = button.parentNode;
        return button;
    }
    function align(label, anchorLabel, side) {
        const item = renderer(buttons.find(button => button.getAttribute('aria-label') === t(label)));
        const anchor = renderer(buttons.find(button => button.getAttribute('aria-label') === t(anchorLabel)));
        if (!item || !anchor) return;
        const box = item.getBoundingClientRect(), target = anchor.getBoundingClientRect();
        if (!box.width || !target.width) return;
        const left = side < 0 ? target.left - box.width - target.width / 4 : target.left + target.width * 1.25;
        // Preserve native focus/navigation and icon sizing, moving only the shortcut.
        positions.push({ item,
            x: Math.round((item.__ttShortcutX || 0) + left - box.left),
            y: Math.round((item.__ttShortcutY || 0) + target.top + (target.height - box.height) / 2 - box.top) });
    }
    align('player.start', 'player.previous', -1);
    align('cdnJournal.title', 'player.next', 1);
    positions.forEach(({ item, x, y }) => {
        item.__ttShortcutX = x; item.__ttShortcutY = y;
        if (item.style.position !== 'relative') item.style.position = 'relative';
        if (item.style.left !== x + 'px') item.style.left = x + 'px';
        if (item.style.top !== y + 'px') item.style.top = y + 'px';
    });
}

// Show request results alongside the player's controls without extra network checks.
if (window.__legacyDirect && parent.__legacyTLS) {
    let lastCDNNotice = 0;
    setInterval(() => {
        const state = parent.__legacyTLS.summary();
        if (state.cdnAddedAt > lastCDNNotice) {
            lastCDNNotice = state.cdnAddedAt;
            if (state.cdnCollecting && Date.now() - state.cdnAddedAt < 8000 && document.querySelector('video')) {
                showToast(t('cdnJournal.title'), t('cdnJournal.added', { count: state.cdnProblems }));
            }
        }
        const controls = document.querySelector('ytlr-player-actions-container');
        let badge = document.querySelector('.tt-media-transport');
        if (!controls) {
            if (badge) badge.style.display = 'none';
            return;
        }
        if (controls.classList.contains('zylon-hidden')) {
            if (badge && badge.style.display !== 'none') badge.style.display = 'none';
            return;
        }
        const style = window.getComputedStyle(controls);
        if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity < 0.5) {
            if (badge && badge.style.display !== 'none') badge.style.display = 'none';
            return;
        }
        const instance = controls.__instance;
        if (instance && instance.__ttRefreshCDNButton) instance.__ttRefreshCDNButton(state.cdnProblems > 0);
        alignPlayerShortcuts(controls);
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tt-media-transport';
            badge.style.cssText = 'position:fixed;right:36px;top:36px;z-index:10000;padding:8px 14px;background:rgba(0,0,0,.75);color:white;font-size:26px;border-radius:6px;pointer-events:none;white-space:pre;';
            document.body.appendChild(badge);
        }
        const label = value => value === 'unknown' ? t('legacyNetwork.unknown') : value;
        const lines = [];
        if (configRead('showCDNCount') && state.cdnProblems > 0) lines.push(t('cdnJournal.counter', { count: state.cdnProblems }));
        if (state.cdnPersistent === false) lines.push(t('cdnJournal.storageError'));
        if (configRead('showPlayerProtocol')) {
            lines.push(t('legacyNetwork.playerVideo', { transport: label(state.video) }));
            if (state.audio && state.audio !== 'unknown' && state.audio !== state.video) {
                lines[lines.length - 1] += ' · ' + t('legacyNetwork.playerAudio', { transport: label(state.audio) });
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
        const displayStyle = lines.length ? 'block' : 'none';
        if (badge.style.display !== displayStyle) badge.style.display = displayStyle;
    }, 500);
}

let patchAttempts = 0;
let playerPatched = false;
const inspectedPlayerMethods = new WeakMap();
function applyPatches() {
    if (playerPatched || !configRead('enablePatchingVideoPlayer')) return;
    if (++patchAttempts > 240) {
        if (window.__legacyLog) window.__legacyLog.record('player.patch', 'Player controls pattern unavailable');
        return;
    }
    if (!window._yttv) return setTimeout(applyPatches, 250);
    const methods = Object.keys(window._yttv).filter(key => {
        const method = window._yttv[key];
        if (typeof method !== 'function') return false;
        if (!inspectedPlayerMethods.has(method)) inspectedPlayerMethods.set(method, method.toString().includes('TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION'));
        return inspectedPlayerMethods.get(method);
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
    const promotedActions = member(func => func.rhs.includes('props.data.promotedActions') &&
        func.rhs.includes('TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION'));
    const navigableIndex = promotedActions && member(func => func.rhs.includes('.' + promotedActions + '().length') && /\+\s*3\b/.test(func.rhs));
    const navigationStep = navigableIndex && member(func => func.rhs.includes('.buttons') && func.rhs.includes('.' + navigableIndex + '('));
    let forceRender;
    for (let proto = origMethod.prototype; proto && !forceRender; proto = Object.getPrototypeOf(proto)) {
        const key = Object.getOwnPropertyNames(proto).find(name => {
            const method = Object.getOwnPropertyDescriptor(proto, name).value;
            return typeof method === 'function' && /this\.[$\w]+\s*=\s*\{\s*[$\w]+:\s*!0,\s*[$\w]+:\s*this\.state\s*\}/.test(method.toString());
        });
        if (key) forceRender = proto[key];
    }
    const mountMethod = Object.getOwnPropertyNames(origMethod.prototype).find(name => {
        const method = Object.getOwnPropertyDescriptor(origMethod.prototype, name).value;
        return typeof method === 'function' && /this\.on\(["']keydown["']/.test(method.toString());
    });
    if (!settingActionGroup || !engagementActionButton || !mountMethod) return;

    function patchPlayerActions(inst) {
        if (inst.__ttPlayerActionsPatched) return inst;
        inst.__ttPlayerActionsPatched = true;
        if (promotedActions && window.__legacyDirect && parent.__legacyTLS) {
            let visible = parent.__legacyTLS.summary().cdnProblems > 0;
            const cdnButton = { type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_TT_CDN',
                button: { buttonRenderer: ButtonRenderer(false, t('cdnJournal.title'), 'INFO',
                    { customAction: { action: 'CDN_SHOW', parameters: {} } }) } };
            const original = inst[promotedActions];
            inst[promotedActions] = function () {
                const actions = original.apply(this, arguments) || [];
                visible = parent.__legacyTLS.summary().cdnProblems > 0;
                return visible ? actions.concat([cdnButton]) : actions;
            };
            inst.__ttRefreshCDNButton = function (value) {
                if (visible === value) return;
                visible = value;
                if (forceRender) forceRender.call(this);
            };
            if (navigationStep && navigableIndex && nextButtonName) {
                const originalStep = inst[navigationStep];
                inst[navigationStep] = function (direction) {
                    const actions = this[promotedActions]();
                    const cdnIndex = actions.indexOf(cdnButton);
                    const selected = this.state.selectedIndex;
                    // Without a Next anchor the shortcut keeps its native position.
                    if (cdnIndex < 0 || selected < 0 || !this[nextButtonName]()) return originalStep.apply(this, arguments);
                    const buttons = this.buttons, nextIndex = actions.length + 2;
                    if (nextIndex >= buttons.length) return originalStep.apply(this, arguments);
                    const order = [];
                    for (let index = 0; index < buttons.length; index++) {
                        if (index !== cdnIndex) order.push(index);
                        if (index === nextIndex) order.push(cdnIndex);
                    }
                    const current = order.indexOf(selected);
                    if (current < 0) return originalStep.apply(this, arguments);
                    for (let index = current + direction; index >= 0 && index < order.length; index += direction) {
                        if (this[navigableIndex](order[index])) return order[index];
                    }
                    return selected;
                };
            }
        }
        if (promotedActions && window.__legacyDirect && parent.__legacyTLS) {
            const original = inst[promotedActions];
            const startButton = { type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_TT_SEEK_START',
                button: { buttonRenderer: ButtonRenderer(false, t('player.start'), 'REPLAY',
                    { customAction: { action: 'SKIP', parameters: { time: 0 } } }) } };
            inst[promotedActions] = function () {
                return (original.apply(this, arguments) || []).concat([startButton]);
            };
        }
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
                            'SPEEDOMETER',
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
