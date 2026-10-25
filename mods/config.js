const CONFIG_KEY = 'ytaf-configuration';
const defaultConfig = {
  enableAdBlock: true,
  enableSponsorBlock: true,
  enableSponsorBlockToasts: true,
  sponsorBlockManualSkips: ['intro', 'outro', 'filler'],
  enableSponsorBlockSponsor: true,
  enableSponsorBlockIntro: true,
  enableSponsorBlockOutro: true,
  enableSponsorBlockInteraction: true,
  enableSponsorBlockSelfPromo: true,
  enableSponsorBlockPreview: true,
  enableSponsorBlockMusicOfftopic: true,
  enableSponsorBlockFiller: false,
  enableSponsorBlockHighlight: true,
  videoSpeed: 1,
  preferredVideoQuality: 'auto',
  tlsMode: 'auto',
  extendedDiagnostics: false,
  collectProblemCDNs: false,
  showCDNCount: true,
  showPlayerProtocol: true,
  sponsorBlockStatusDisplay: 'unavailable',
  enableDeArrow: true,
  enableDeArrowThumbnails: false,
  focusContainerColor: '#0f0f0f',
  routeColor: '#0f0f0f',
  enableFixedUI: (window.h5vcc) ? false : true,
  enableHqThumbnails: false,
  enableChapters: true,
  enableLongPress: true,
  enableShorts: true,
  dontCheckUpdateUntil: 0,
  enableWhoIsWatchingMenu: false,
  permanentlyEnableWhoIsWatchingMenu: false,
  enableWhosWatchingMenuOnAppExit: false,
  enableShowUserLanguage: true,
  enableShowOtherLanguages: false,
  showWelcomeToast: true,
  enablePreviousNextButtons: true,
  enableSuperThanksButton: false,
  enableAIAskButton: false,
  enableSpeedControlsButton: true,
  enablePatchingVideoPlayer: true,
  enableMPButton: true,
  enableSwapMPWithPIP: false,
  enablePreviews: true,
  enableHideWatchedVideos: false,
  hideWatchedVideosThreshold: 80,
  hideWatchedVideosPages: [],
  enableHideEndScreenCards: false,
  enableYouThereRenderer: true,
  lastAnnouncementCheck: 0,
  enableScreenDimming: false,
  dimmingTimeout: 60,
  dimmingOpacity: 0.5,
  enablePaidPromotionOverlay: true,
  speedSettingsIncrement: 0.25,
  preferredVideoCodec: 'any',
  launchToOnStartup: null,
  reloadHomeOnStartup: true,
  disabledSidebarContents: [],
  sidebarContentsOrder: [],
  disableChannelsOnSidebar: false,
  enableUpdater: true,
  autoFrameRate: false,
  autoFrameRatePauseVideoFor: 0,
  enableSigninReminder: false,
  sortSubscriptionsByAlphabet: false,
  enableClock: false,
  isClock12HourFormat: false,
  clockShowSeconds: false,
  clockHideWhenVideoPlaying: false,
  disableEnlargingThumbnails: false,
  enableShrinkingThumbnails: false,
  hideRelatedVideosPlayer: false,
};

const localConfig = Object.create(null);
let savedConfig = {}, storageFailed = false, repairTLS = false;
try {
  const parsed = JSON.parse(window.localStorage[CONFIG_KEY]);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) savedConfig = parsed;
} catch (_) { console.warn('Config read failed'); }
Object.keys(savedConfig).forEach(key => { localConfig[key] = savedConfig[key]; });
Object.keys(defaultConfig).forEach(key => {
  const fallback = defaultConfig[key], value = localConfig[key];
  const valid = Array.isArray(fallback) ? Array.isArray(value) :
    typeof value === typeof fallback && (typeof fallback !== 'number' || Number.isFinite(value));
  if (!valid) localConfig[key] = Array.isArray(fallback) ? fallback.slice() : fallback;
  else if (Array.isArray(fallback)) localConfig[key] = value.filter(item => typeof item === 'string' ||
    (key === 'sidebarContentsOrder' && item && typeof item.browseId === 'string' && typeof item.title === 'string'));
});
if (!(localConfig.videoSpeed > 0 && localConfig.videoSpeed <= 5)) localConfig.videoSpeed = defaultConfig.videoSpeed;
if (!(localConfig.speedSettingsIncrement > 0 && localConfig.speedSettingsIncrement <= 5)) localConfig.speedSettingsIncrement = defaultConfig.speedSettingsIncrement;
if (!['auto', '1.2', '1.3'].includes(localConfig.tlsMode)) localConfig.tlsMode = defaultConfig.tlsMode;
repairTLS = savedConfig.tlsMode !== localConfig.tlsMode;

function saveConfig() {
  try {
    window.localStorage[CONFIG_KEY] = JSON.stringify(localConfig);
    storageFailed = false;
    return true;
  } catch (_) {
    console.warn('Settings could not be saved');
    if (!storageFailed) {
      storageFailed = true;
      setTimeout(() => configChangeEmitter.dispatchEvent(new CustomEvent('configStorageError')), 0);
    }
    return false;
  }
}

export function configRead(key) {
  if (key === 'tlsMode' && repairTLS) { repairTLS = false; saveConfig(); }
  if (localConfig[key] === undefined) {
    console.warn('Populating key', key, 'with default value', defaultConfig[key]);
    localConfig[key] = Array.isArray(defaultConfig[key]) ? defaultConfig[key].slice() : defaultConfig[key];
  }

  return localConfig[key];
}

export function configWrite(key, value) {
  console.info('Setting key', key, 'to', value);
  localConfig[key] = value;
  saveConfig();
  if (key === 'tlsMode' && window.__legacyDirect && parent.__legacyTLS) parent.__legacyTLS.setMode(value);
  if (key === 'extendedDiagnostics' && window.__legacyDirect && parent.__legacyTLS) parent.__legacyTLS.setDiagnostics(value);
  if (key === 'collectProblemCDNs' && window.__legacyDirect && parent.__legacyTLS) parent.__legacyTLS.setCDNCollection(value);
  configChangeEmitter.dispatchEvent(new CustomEvent('configChange', { detail: { key, value } }));
}

export const configChangeEmitter = {
  listeners: {},
  addEventListener(type, callback) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(callback);
  },
  removeEventListener(type, callback) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter(cb => cb !== callback);
  },
  dispatchEvent(event) {
    const type = event.type;
    if (!this.listeners[type]) return;
    this.listeners[type].forEach(cb => {
      try {
        cb.call(this, event)
      } catch (_) {};
    });
  }
};
