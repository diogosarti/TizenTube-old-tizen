// Share event-driven rebinding between features; polling stops after discovery.
const listeners = new Set();
let player, video, retry = null, started = false, discovered = false;
function refreshPlayer() {
    clearTimeout(retry); retry = null;
    const nextPlayer = document.querySelector('.html5-video-player');
    const nextVideo = document.querySelector('video');
    if (nextPlayer) discovered = true;
    if (nextPlayer !== player || nextVideo !== video) {
        player = nextPlayer; video = nextVideo;
        listeners.forEach(listener => listener(player, video));
    }
    if (!player && !discovered) retry = setTimeout(refreshPlayer, 250);
}
export function watchPlayer(listener) {
    if (!started) {
        listeners.add(listener);
        started = true;
        ['loadedmetadata', 'canplay', 'playing', 'emptied'].forEach(type => document.addEventListener(type, refreshPlayer, true));
        window.addEventListener('hashchange', refreshPlayer);
        refreshPlayer();
    } else {
        refreshPlayer();
        listeners.add(listener);
        listener(player, video);
    }
}
