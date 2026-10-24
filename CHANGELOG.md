# Changelog

## v2.3.26

- Added a Go to beginning button beside Previous video, seeking the current video to 0:00.
- Aligned binary XHR response buffers with the requesting frame for compatibility with legacy WebKit.
- Added an optional persistent journal of up to 50 problematic Googlevideo domains. Collection is disabled by default and works without a PC or Web Inspector.
- Added a full-screen CDN list with wrapped hostnames, failure details, individual deletion and confirmed clearing.
- Added an optional player counter shown only when the problematic-domain count is greater than zero, plus notifications for newly listed domains.

## v2.3.21

- Disabled extended diagnostics by default while retaining saved user preferences and the live settings toggle.
- Fixed automatic SponsorBlock skipping when segment data arrives late or playback resumes inside a segment.
- Replaced response-order-dependent manual SponsorBlock actions with an independent skip prompt (Yellow / 3 while the player menu is closed).
- Fixed the watched-video filter ignoring its disabled setting and failing to filter lockupViewModel cards.
- Restored Auto, TLS 1.2 only, and TLS 1.3 only modes, with TLS 1.2 as the default. TLS 1.3 playback stalls on the tested Tizen 2.4 TV remain under investigation; TLS 1.3 worked on another Tizen 3 TV with a different network configuration.

## v2.3.20 (beta)

- Added correlated XHR completion timings for response assembly and slow synchronous event handlers to investigate playback hitches after media downloads.

## v2.3.19 (beta)

- Added a saved Extended diagnostics toggle, currently enabled by default, with live disabling of detailed network and playback measurements.
- Added correlated network request IDs, track and endpoint labels, native connection-stage timings and completion/cancellation diagnostics.
- Added active-request snapshots during buffering and media pause, seek and rate-change events to diagnostics.

## v2.3.18 (beta)

- Fixed delayed SponsorBlock unavailability reporting by limiting segment requests to 10 seconds instead of the shared 120-second network timeout.
- Canceled unfinished SponsorBlock segment requests when switching videos.

## v2.3.17 (beta)

- Forced TLS 1.2 instead of Auto as a workaround for observed TLS 1.3 playback stalls; a fix is being investigated.
- Fixed the custom playback-speed menu for YouTube's new speed icon while retaining support for the previous icon.
- Reduced network response copying and improved incremental UTF-8 text decoding.
- Improved XHR loading and progress event handling.
- Fixed preferred-quality fallback to the nearest available lower resolution and restored adaptive quality when selecting Auto.
- Reduced duplicate DeArrow requests with caching, lower request priority and cancellation on navigation.
- Fixed the default preferred-codec setting.

## v2.3.16 (beta)

- Fixed premature SponsorBlock skips during buffering and adjusted skip scheduling for playback speed changes.
- Prevented pending telemetry requests from blocking playback and watch-history requests.
- Fixed DeArrow title and thumbnail updates for both supported video card formats.

## v2.3.9

- Added the actual googlevideo TLS protocol in the upper-right corner of the player controls, with an option to hide it.
- Added SponsorBlock availability display modes: hidden, only when unavailable (default), or always.
- Set player indicator defaults to show the TLS protocol and display SponsorBlock status only when unavailable; Auto remains the default TLS mode.

## v2.3.8 — 2026-10-11

- Added TLS 1.3 support for YouTube API requests and video playback on older Tizen TVs.
- Added Auto, TLS 1.2 only, and TLS 1.3 only connection modes.
- Added separate negotiated TLS version indicators for API and video connections.
- Added gzip response decoding and a limited retry for connection resets during the TLS handshake.

## v2.2.0 — 2026-10-10

First release of the Old Tizen fork, based on TizenTube Standalone v2.1.1 with later upstream module changes retained.

- Added standalone YouTube playback with SponsorBlock for the tested Tizen 2.4.0 TV, without a viewing-time computer, proxy or local service.
- Adapted JavaScript and browser APIs to the legacy WebKit runtime; packaged scripts are checked for ES5 compatibility.
- Adapted SponsorBlock seeking to the YouTube player API and retained segment marks during seeking.
- Packaged the release without personal certificates or device-specific signatures; installation requires signing for the target TV.

Tested device: Samsung UE50KU6000 (KU6000 series), Tizen 2.4.0, firmware T-JZL6DEUC-1260.1. No other TV model has been confirmed.
