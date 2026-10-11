# Building and debugging the Old Tizen widget

The released application uses `widget/index.html` and a local `player.html` frame. It retrieves YouTube TV HTML directly, inserts compatibility scripts and the TizenTube bundle, then writes the document into that frame. The service-based prototype is not included in the widget.

## Build and sign

From the repository root:

```text
npm --prefix mods install
npm --prefix legacy install
```

The repository includes the stripped ARM module used in the release. To rebuild it, use Samsung NaCl SDK Pepper 42, Mbed TLS 3.6.7 and [zlib 1.3.2](https://zlib.net/):

```powershell
./legacy/native/build.ps1 -SdkRoot <pepper_42-directory> -MbedTlsRoot <mbedtls-3.6.7-directory> -ZlibRoot <zlib-1.3.2-directory>
```

Use `-SkipLibraries` only when the libraries have already been built from the same dependency versions with the unchanged `mbedtls_user_config.h`. The module is stripped and contains no debug metadata. The bundled public CA roots are the Mozilla PEM export from [curl](https://curl.se/docs/caextract.html), dated 2026-09-25 and licensed under MPL 2.0. Its source is `native/assets/ca-roots.pem`; it is embedded at compile time. Update that file explicitly when updating trust anchors.

Then test and package the widget (replace VERSION with the local package version):

```text
npm --prefix legacy test
npm --prefix legacy run build
tizen package -t wgt -s YOUR_CERTIFICATE_PROFILE -o <absolute-artifacts-directory>/VERSION/signed -- <absolute-stage-directory>/widget-VERSION
```

The build checks ES5 syntax, rejects source maps and WebKit-incompatible function declarations inside blocks, checks the manifest version and refuses unexpected files in a reused stage. Previous version directories are retained.

Output files are the unsigned WGT, a release ZIP containing a WGT requiring signing, and the stage for the Samsung packager. The ZIP excludes signatures, certificates, tools, dependencies and debug metadata. The packaged third-party notices also include dependency license texts.

The application ID remains `TTIconT029.IconTest` and the package ID remains `TTIconT029` to permit updates of the validated installation without deleting its data.

## Install and launch

Replace `TV_IP` with the TV address:

```text
sdb connect TV_IP:26101
tizen install -n TizenTube-old-tizen.wgt -s TV_IP:26101 -- <absolute-artifacts-directory>/VERSION/signed
sdb -s TV_IP:26101 shell 0 was_execute TTIconT029.IconTest
```

A normal launch from Apps or `was_execute` does not enable Web Inspector. It still collects the in-memory log, which can be shown using Red or 1.

## Web Inspector

```text
sdb -s TV_IP:26101 shell 0 debug TTIconT029.IconTest 300
```

The command returns a port. Open `http://TV_IP:PORT/`; the older inspector lists pages at `/pagelist.json`. An SDB debug launch can display Samsung's RWI mapping dialog.

To read the redacted log without saving it to disk (PowerShell):

```powershell
'JSON.stringify(window.__legacyLog.read())' | node legacy/inspect.js ws://TV_IP:PORT/devtools/page/ID
```

Web Inspector permits JavaScript execution and access to account data without separate authentication. Use it only on a trusted network and close the application after diagnosis. A later launch from Apps returns to normal mode.

The logger keeps up to 300 entries in each of the shell and frame buffers, records playback samples every ten seconds while playing, and removes sensitive values from diagnostic strings. Closing the app clears the buffers. OAuth response classification used during manual investigation is not a shipped feature.

## Loading feedback and networking

The shell owns the dotted indicator and its clockwise keyframes. Frame media events supply loading, buffering and seeking states; visible YouTube spinners supply a generic loading state. Messages are English regardless of the YouTube interface language.

The local TLS integration routes asynchronous HTTPS XMLHttpRequest and fetch requests through an ARM NaCl module with Mbed TLS 3.6.7. This includes the initial YouTube HTML, JSON APIs, OAuth requests, playback/history pings, SponsorBlock, and the binary POST/range requests used by the MSE video player. The existing player still decodes audio/video and handles seeking. TCP connections originate on the TV; no computer service is used. HTTP/1.1 is used, without QUIC. Gzip responses are decoded incrementally with CRC/truncation checks; unsupported content encodings are rejected.

Green → Network / TLS selects a persisted mode: Auto (minimum TLS 1.2, maximum TLS 1.3), TLS 1.2 only, or TLS 1.3 only. Forced modes have identical minimum and maximum versions; there is no retry through the system stack when a native request fails. Certificate chains and the requested hostname are always verified. The mode applies to new connections; existing requests retain the mode they started with. Restart playback or the interface to replace existing connections.

Settings and shell diagnostics display the latest actually negotiated NaCl TLS separately for Interface/API and Video. DOM resource loads (scripts, styles, images), plain HTTP, and any direct non-MSE media source remain on the system stack. That stack does not expose its TLS version; it is shown as unknown and is not controlled by the NaCl mode. Synchronous HTTPS XHR is unsupported. Native responses are limited to 64 MiB per request, so media uses segments/ranges rather than an entire-file buffer. Redirects stay on HTTPS and remove authorization on a different origin. A TCP read failure during the TLS handshake is retried once in the original mode, before any HTTP request can have been sent. Certificate errors, TLS version failures and failures after the handshake are not retried.

The module's read-only `inspect()` diagnostics contain request IDs, parser byte counts and pending-operation flags only. URLs, headers, bodies, cookies and account credentials are not included in those diagnostics or the in-memory log.

The player controls opened with Enter show the transport that delivered successful googlevideo media data, rather than the configured mode or an API connection. The indication is reset for a new media ID and ignores data from previous streams. If separately identified audio uses another transport, its value is also shown. System playback is shown as unknown.

Player indicators settings can hide the playback protocol (shown by default) and show SponsorBlock availability never, only when unavailable (default), or always. Both appear in the upper-right corner with the player controls. SponsorBlock status comes from the existing segment request for the current video, without additional probes. A successful response without segments or HTTP 404 means available; network, HTTP and response parsing errors mean unavailable. Always mode also shows checking and disabled states.

## Verified behavior

Version 2.3.8 was tested on Samsung KU6000 with Tizen 2.4. Auto negotiated verified TLS 1.3 for YouTube API and video requests and verified TLS 1.2 for a TLS-1.2-only endpoint. Forced TLS 1.3 rejected that endpoint without falling back. Negotiation is per connection; one TLS 1.2 result does not downgrade other connections. Auto does not make a separate forced-TLS-1.2 attempt after a network failure.

The saved mode survived restarts. Playback, seeking, pause/resume, SponsorBlock skipping and authenticated history requests worked. Incorrect hostnames and self-signed certificates were rejected. Intermittent DNS failures and TCP resets were observed; long-session reliability and fresh QR sign-in have not been established.
