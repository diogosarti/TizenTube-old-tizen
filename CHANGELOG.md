# Changelog

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
