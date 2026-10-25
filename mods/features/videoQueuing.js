import resolveCommand from '../resolveCommand.js';
import { watchPlayer } from '../utils/playerLifecycle.js';
import { getQueuedVideoId } from '../utils/videoCards.js';

let player = null, video = null, advanceTimer = null, revision = 0;
function cancelAdvance() {
    clearTimeout(advanceTimer); advanceTimer = null; revision++;
}
window.queuedVideos = {
    videos: [], lastVideoId: null,
    add(card) { cancelAdvance(); this.videos.push(card); },
    clear() { cancelAdvance(); this.videos = []; this.lastVideoId = null; }
};
function onStateChange() {
    const queue = window.queuedVideos;
    const state = player?.getPlayerStateObject?.();
    const id = player?.getVideoData?.()?.video_id;
    if (!state || !queue.videos.length) { cancelAdvance(); return; }
    if (state.isPlaying) {
        cancelAdvance();
        const container = document.getElementById('container');
        if (container) container.style.setProperty('opacity', '1', 'important');
        if (queue.videos.some(card => getQueuedVideoId(card) === id)) queue.lastVideoId = id;
        return;
    }
    if (!state.isEnded) { cancelAdvance(); return; }
    if (advanceTimer !== null) return;
    const index = queue.videos.findIndex(card => getQueuedVideoId(card) === id);
    const previous = index !== -1 ? index : queue.videos.findIndex(card => getQueuedVideoId(card) === queue.lastVideoId);
    const target = queue.videos[previous + 1];
    if (!target) { resolveCommand({ customAction: { action: 'CLEAR_QUEUE' } }); return; }
    const source = player, version = revision, list = queue.videos;
    advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (version !== revision || source !== player || player.getVideoData()?.video_id !== id ||
            !player.getPlayerStateObject()?.isEnded || list !== queue.videos || !queue.videos.includes(target)) return;
        resolveCommand(target.tileRenderer ? target.tileRenderer.onSelectCommand : target.lockupViewModel.rendererContext.commandContext.onTap.innertubeCommand);
    }, 500);
}
watchPlayer((next, nextVideo) => {
    if (next === player && nextVideo === video) return;
    cancelAdvance();
    player?.removeEventListener('onStateChange', onStateChange);
    player = next;
    video = nextVideo;
    if (player) { player.addEventListener('onStateChange', onStateChange); onStateChange(); }
});
window.addEventListener('hashchange', cancelAdvance);
