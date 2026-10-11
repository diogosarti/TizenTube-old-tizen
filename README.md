# TizenTube — Old Tizen

[README на русском](README_RU.md)

This is a fork of [reisxd/TizenTube](https://github.com/reisxd/TizenTube), based on **TizenTube Standalone v2.1.1** and adapted for older Samsung TVs. Its main difference is **YouTube playback with SponsorBlock on Tizen 2.4.0**. **TLS 1.3 support is enabled for API and video requests**, with automatic TLS 1.2–1.3 negotiation by default. Later upstream module changes are also retained.

The app runs entirely on the TV. It loads the YouTube TV interface directly and adds TizenTube modifications through a launcher adapted to the older WebKit engine. No computer, external proxy or local service is needed during viewing.

**Tested device:** Samsung UE50KU6000 (KU6000 series), Tizen 2.4.0, firmware T-JZL6DEUC-1260.1. No other TV model has been confirmed.

| | |
|---|---|
| App name | TizenTube-old-tizen |
| Package version | 2.3.9 |
| Upstream base | [TizenTube Standalone v2.1.1](https://github.com/reisxd/TizenTube/releases/tag/v2.1.1) |
| License | GPL-3.0-only; see [LICENSE](LICENSE) and [third-party notices](legacy/THIRD_PARTY_NOTICES.txt) |
| Release | [Download the installation package](https://github.com/numbereleven-a/TizenTube-old-tizen/releases/latest) |
| Changes | [Changelog](CHANGELOG.md) |

## Install

The release ZIP contains an unsigned WGT. Sign it with a Samsung certificate profile that includes your TV's DUID before installation. Personal certificates and device-specific signatures are not included in the download.

1. Download `TizenTube-old-tizen-v2.3.9.zip` from the [latest release](https://github.com/numbereleven-a/TizenTube-old-tizen/releases/latest) and extract `TizenTube-old-tizen-v2.3.9-resign-required.wgt`.
2. Install Tizen Studio with Samsung TV Extension and Certificate Manager.
3. Enable Developer Mode, connect the TV, and create a Samsung certificate profile for it. See Samsung's [certificate guide](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html) and [TV connection guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html).
4. [Import the WGT as a Tizen project](https://developer.samsung.com/smarttv/develop/getting-started/creating-tv-applications/importing-tv-applications.html), select your certificate profile, and package it again.
5. Install the newly signed WGT on the connected TV and launch **TizenTube-old-tizen** from Apps.

The app opens YouTube with the modifications enabled. It is not distributed through Samsung Apps. Building from source is described below.

### Updating an existing installation

The release retains the application identifiers from the final local test builds. Sign updates with the same author certificate and install over the existing application to retain its account and settings. An expired or revoked authorization can still require signing in again. Uninstalling the application clears its local data.

## SponsorBlock and playback

- **SponsorBlock:** skips known sponsored segments and shows their marks on the progress bar, including while seeking. [SponsorBlock](https://sponsor.ajay.app/) uses community-submitted timestamps for sponsorships embedded in the video; an unreported segment cannot be skipped automatically.
- **YouTube account:** the standard QR authorization flow is retained. Account sign-in, saved sessions and watch history synchronization were confirmed on the tested TV.
- **Playback:** video, audio, pause, seeking, SponsorBlock marks and relaunch were verified on the configuration above.

Upstream ad-blocking and other TizenTube features remain in the source. Full compatibility of every upstream feature is not claimed.

## Controls and diagnostics

| Button | Action |
|---|---|
| Arrows / Enter / Return | Normal YouTube navigation |
| Green | TizenTube settings |
| Red or 1 | Show or hide the in-memory log |
| 2 | Reload YouTube with the current mode |
| Blue or 4 | Open diagnostics and stop playback |

Diagnostics offers **Restart TizenTube** and **Try without modifications**. The latter is a comparison mode for the current session; the next app launch enables TizenTube again. Return in diagnostics closes the app.

Logs remain in memory, are hidden by default and are cleared when the app closes. They include errors, HTTP results for history, playback state and buffering information. Tokens, cookies and full request URLs are not intentionally recorded; diagnostic strings are redacted. Web Inspector requires a separate debug launch and is not enabled by a normal launch from Apps. See the [build and debugging guide](legacy/README.md).

## Requirements and compatibility

The confirmed configuration is the KU6000/Tizen 2.4.0 above. The app needs the Samsung Tizen Web Application runtime, working media playback/MSE, supported video and audio decoders, and network access to YouTube, its media hosts and SponsorBlock.

The manifest's Tizen 2.4 minimum is an installation requirement, not proof of compatibility with every Tizen 2.4 or newer TV. Other models, firmware versions, codecs and all video resolutions have not been verified. YouTube can change its interface and scripts independently of this project.

On the tested setup, QR sign-in sometimes required a second attempt in the YouTube mobile app. That phone-side behavior has not been resolved. A connection failure opens diagnostics so the load can be retried manually.

HTTPS API and MSE video requests support TLS 1.3 through a bundled ARM NaCl module. Green → Network / TLS selects Auto (TLS 1.2–1.3), forced TLS 1.2 or forced TLS 1.3, and displays the negotiated version separately for API and video. Auto negotiates per connection; forced TLS 1.3 cannot reach TLS-1.2-only servers. DOM resources remain on the TV's system stack, whose TLS version is unknown. See the [TLS guide and verification notes](legacy/README.md).

## Upstream project

The base is [TizenTube Standalone v2.1.1](https://github.com/reisxd/TizenTube/releases/tag/v2.1.1). This fork replaces the service-based launcher for the tested Tizen 2.4.0 runtime, supplies ES5-compatible bundles and adapts playback and SponsorBlock seeking. Upstream copyright and license notices are retained.

## Build

Install Node.js and Tizen Studio with Samsung TV Extension and certificate tools. From the repository root:

```text
npm --prefix mods install
npm --prefix legacy install
npm --prefix legacy test
npm --prefix legacy run build
```

The build checks packaged JavaScript for ES5 compatibility and produces `artifacts/2.3.9/TizenTube-old-tizen-v2.3.9.zip`. Sign the staged widget with your own certificate profile:

```text
tizen package -t wgt -s YOUR_CERTIFICATE_PROFILE -o artifacts/2.3.9/signed -- legacy/dist/widget-2.3.9
```

The `legacy/widget` launcher is the released application. The older `standalone` and service sources are retained from upstream and are not included in this WGT.
