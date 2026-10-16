import { configRead, configChangeEmitter } from "../config.js";

const SELECTORS = {
    PLAYER: '.html5-video-player',
};

const EVENTS = {
    YT_STATE_CHANGE: 'onStateChange',
    CONFIG_CHANGE: 'configChange',
};

const CONFIG_KEYS = {
    QUALITY: 'preferredVideoQuality',
};

class PreferredQualityHandler {
    #player = null;
    #attachTimeout = null;
    #lastVideoId = null;
    #hasAppliedQuality = false;
    #qualityLocked = false;

    constructor() {
        this.init();
    }

    init() {
        this.#pollForPlayer();
        this.#setupConfigListener();
    }

    #pollForPlayer() {
        clearTimeout(this.#attachTimeout);

        const playerElement = document.querySelector(SELECTORS.PLAYER);

        if (!playerElement) {
            this.#attachTimeout = setTimeout(() => this.#pollForPlayer(), 100);
            return;
        }

        this.#player = playerElement;

        this.#player.addEventListener(EVENTS.YT_STATE_CHANGE, this.#handleStateChange);

        this.#handleStateChange();
    }

    #setupConfigListener() {
        configChangeEmitter.addEventListener(EVENTS.CONFIG_CHANGE, (ev) => {
            if (ev.detail?.key === CONFIG_KEYS.QUALITY) {
                this.#hasAppliedQuality = this.#applyQuality();
            }
        });
    }

    #handleStateChange = () => {
        const state = this.#player?.getPlayerStateObject?.();
        const videoData = this.#player?.getVideoData?.();
        const videoId = videoData?.video_id;

        if (videoId !== this.#lastVideoId) {
            this.#lastVideoId = videoId;
            this.#hasAppliedQuality = false;
        }

        const isShorts = Object.values(this.#player.getVideoStats()).find(a => a && a === 'shortspage');
        if (state?.isPlaying && !this.#hasAppliedQuality && !isShorts) {
            this.#hasAppliedQuality = this.#applyQuality();
        }
    };

    #applyQuality() {
        const preferredQuality = configRead(CONFIG_KEYS.QUALITY);
        if (!preferredQuality || !this.#player) return false;

        try {
            if (preferredQuality === 'auto') {
                if (this.#qualityLocked) this.#player.setPlaybackQualityRange('auto', 'auto');
                this.#qualityLocked = false;
                return true;
            }
            const quality = this.#determineQuality(preferredQuality);

            if (quality) {
                this.#player.setPlaybackQualityRange(quality, quality);
                this.#qualityLocked = true;
                return true;
            }
        } catch (e) {
            console.warn('[PreferredQuality] Failed to apply quality:', e);
        }
        return false;
    }

    #determineQuality(preference) {
        const availableQualities = this.#player.getAvailableQualityData();
        if (!availableQualities?.length) return null;

        const getQualityValue = (label) => parseInt(label, 10) || 0;
        const targetValue = getQualityValue(preference);

        const candidates = availableQualities.filter(q => {
            const value = getQualityValue(q.qualityLabel);
            return value > 0 && value <= targetValue;
        });
        candidates.sort((a, b) => getQualityValue(b.qualityLabel) - getQualityValue(a.qualityLabel));
        return candidates.length ? candidates[0].quality : null;
    }
}

window.preferredVideoQualityHandler = new PreferredQualityHandler();
