export function getQueuedVideoId(card) {
    const renderer = card && (card.tileRenderer || card.lockupViewModel);
    return renderer ? renderer.contentId : null;
}
