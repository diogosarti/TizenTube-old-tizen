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

On `waiting` or `stalled`, `video.stall-tracks` records the audio/video buffer ahead of the current playback position from YouTube's `lab`/`lvb` statistics, media readiness, playback rate, seeking state, the media error code and available frame counters. Missing or unrecognized track ranges are reported as `unknown`, not as an empty buffer. Track-specific errors are not exposed and remain `unknown`; `video.stall-network` reports aggregate transport counters separately. Five follow-up snapshots run approximately one second apart, including after playback resumes, using the existing status timer. Replacing the video element or starting/unloading/ending media cancels the previous series. These measurements help investigate stalls but do not establish whether the network, JavaScript, MSE or decoder caused them.

Settings → Extended diagnostics (Расширенная диагностика in Russian) controls detailed logging without restarting the app. It is disabled by default; an explicitly saved choice is retained between launches. Turning it off stops detailed network lifecycle records, native stage/read/ticket measurements, buffering snapshots and periodic media samples; basic errors, TLS status and loading feedback remain available. Turning it back on enables full native measurements for new requests; requests already running without measurements are not given partial timings. This switch does not enable Web Inspector or start the PC recorder, and the recorder does not override it.

The local 2.4.1 build also measures slow status/control DOM work as `ui.status-work` and `ui.controls-work` when an update takes at least 50 ms. Recorder samples include optional XHR memory fields: `pendingBytes` for buffers held by outstanding XHRs, `pendingRequests`, and `assemblyPeakBytes` for the largest reachable binary-buffer footprint at final response assembly. These are transport-buffer measurements, not total heap/RSS or proof of a leak; completed responses retained by callers are not included in `pendingBytes`. Measurements are disabled with Extended diagnostics. No additional network checks or DOM polling intervals are added.

Local version 2.3.19 adds `net.queued`, `net.start`, `net.headers`, `net.first-data`, bounded `net.progress`, `net.end` and `net.timing` records. `rid` identifies a logical request across retries/redirects; `id` identifies its native attempt. Labels include the host, HTTP method, sanitized endpoint name, format itag and an audio/video/API classification derived from request MIME parameters or response MIME. Unidentified media stays `unknown`; opaque request payloads are not decoded to guess a track. No query strings, headers or bodies are logged. Native snapshots distinguish DNS, TCP connect, TLS handshake, request submission, response headers and response body, with per-stage elapsed times, socket byte/read counters, time since the last successful read, and processed TLS 1.3 ticket counts. `connectionReused` means an existing open connection, not TLS session resumption. HTTP send/header timing is measured at the TLS API boundary, not as a packet capture. The PC recorder retains these fields. During buffering the frame also requests bounded `net.pending` snapshots for the in-memory log. Native replies arriving after an XHR cancellation are logged separately as `net.native-end`; an XHR timeout can therefore be distinguished from its subsequent native abort acknowledgement. Media pause, seeking, seeked and rate-change events are recorded, without treating seek-preview initialization as a remote-control action. This local build has not been validated on TV.

Local version 2.3.20 adds `net.xhr-done` with request IDs, response byte/chunk counts, assembly time and total synchronous DONE processing time. `net.xhr-event` records synchronous event dispatches taking at least 100 ms, including the event name and readyState captured before dispatch. Timings are elapsed wall-clock measurements, not CPU profiles; nested handlers, garbage collection and scheduling pauses can contribute. Asynchronous work after the handlers return is outside these measurements. They obey the Extended diagnostics setting and do not change network retries or playback behavior.

For continuous recording on a connected PC, keep a debug session open and run:

```sh
node legacy/record-diagnostics.js TV_IP OUTPUT_DIRECTORY
```

The recorder drains the shell log (including forwarded frame events) and samples selected playback buffers, playback rate and TLS counters once per second. It writes JSON Lines files, rotates at 16 MiB and retains up to 32 recorder files in the chosen directory. That directory should be dedicated to diagnostics; retention also covers recorder files from previous runs. It never deletes unrelated files. Ctrl+C stops recording. Keep the PC and recorder running while watching. After a connection loss it waits and reconnects to an available debug session without restarting the TV app. A normal app launch requires another debug launch. Missing ring-buffer entries are reported; activity during a disconnected interval cannot be recovered after the buffer wraps or the app closes. Account data, complete URLs, headers and response bodies are not collected; arbitrary page exception messages are omitted. Clock ratios are diagnostic measurements and can also change during a seek or video transition.

For an explicit short CPU capture, create an empty `cpu-profile.request` file in the recorder output directory. The updated recorder consumes it, starts a nominal 5-second profile on its existing Inspector connection, and saves `ttcpu-*.json` alongside ordinary logs. Start the capture before reproducing a seek or other slow action. It is off by default; no second Inspector connection or TV package update is needed. A recorder already running older code must be restarted first. The profile retains function names, script basenames, call-tree links and numeric timings/samples, without script text, local paths, URL queries or page values. Profile files are not part of JSONL rotation; keep only captures needed for investigation. Profiling can slow the TV, and a blocked Inspector can delay stopping or prevent retrieval. The recorder attempts to stop an active profiler before disconnecting, but cannot guarantee cleanup after a lost connection or forced process termination. Compare the same operation without profiling before attributing observed delays to normal playback.

## Persistent CDN journal

Settings > Problematic CDNs opens a full-screen list with wrapped Googlevideo hostnames and failure metadata. When the journal contains entries, a shortcut beside Next video also opens it; the shortcut disappears when the last entry is removed. The player shortcut immediately before Previous video seeks to 0:00. Collection is disabled by default; enable Collect problematic GGC domains in settings to collect without Extended diagnostics, Web Inspector or a computer. Disabling collection retains saved entries. The journal uses persistent Web Storage with at most 50 entries. It never stores signed media URLs, headers or account data. Storage errors are shown instead of interrupting playback.

An unlisted domain needs two distinct failed requests within ten minutes. A successful media response clears its unconfirmed candidate. Requests outside `/videoplayback`, HTTP error responses, short cancellations, recent user input, seeking, pauses, video replacement and navigation are excluded. Quiet cancellations before TLS completion after at least ten seconds, or before response headers after fifteen seconds, are recorded as suspected connection waits, not proof of blocking. Connectivity loss can still cause repeated failures; this is a manual investigation list, not an automatic VPN rule generator.

The separate Show problematic GGC count when nonzero setting is enabled by default. With player controls visible, it shows the count beside TLS information only when greater than zero. A brief toast announces newly listed domains while collection is enabled. Delete removes one entry; clear requires confirmation. There is no processed-history list. A deleted domain requires two new qualifying failures to return. At capacity, the least recently failing entry is removed. Unconfirmed candidates are bounded in memory, are not persisted and are reset when toggling collection.

With Web Inspector enabled, `window.__legacyTLS.problemCDNs.read()` returns the journal. The PC recorder exports it as a `cdn-journal` record when its content changes, even with Extended diagnostics off. Saved entries survive application restarts. Removing the application clears its local data. The journal records repeated connection failures, not confirmed network blocks.


## Loading feedback and networking

The shell owns the dotted indicator and its clockwise keyframes. Frame media events supply loading, buffering and seeking states; visible YouTube spinners supply a generic loading state. Messages are English regardless of the YouTube interface language.

Local version 2.3.15 corrects storyboard image URLs that YouTube derives from the widget's `file:` origin. Only storyboard URLs on `i.ytimg.com` are changed to HTTPS; their native sprite geometry is preserved. The seek timestamp also shows the signed offset from the playback position held at the start of seeking, for example `1:34 (+0:10)` or `1:05 (−0:15)`.

Local version 2.3.16 checks the actual playback position before SponsorBlock skips and reschedules on buffering, seeking and playback speed changes. Playback and watch-history requests use the API queue independently of the single telemetry slot. DeArrow processes both video card formats again. These fixes have local regression coverage; TV validation is pending.

Local version 2.3.17 avoids copying a single binary response chunk and decodes growing UTF-8 text incrementally without repeatedly joining the received byte prefix. LOADING notifications repeat at approximately 50 ms intervals when data arrives, followed by a final progress event before DONE. Binary responses remain unavailable until DONE. Preferred quality falls back to the nearest available lower resolution; Auto resets a range previously applied by the mod. DeArrow branding shares the single background slot, combines pending requests for the same video, caches at most 128 successful results for five minutes in memory and cancels pending requests on hash navigation. Playback diagnostics follow replacement video elements and report delayed 500 ms timer callbacks; those measurements are not a GC counter. The native TLS module and block sizes are unchanged. TV validation of this version is pending, and the intermittent playback stall remains unresolved.

The local TLS integration routes asynchronous HTTPS XMLHttpRequest and fetch requests through an ARM NaCl module with Mbed TLS 3.6.7. This includes the initial YouTube HTML, JSON APIs, OAuth requests, playback/history pings, SponsorBlock, and the binary POST/range requests used by the MSE video player. The existing player still decodes audio/video and handles seeking. TCP connections originate on the TV; no computer service is used. HTTP/1.1 is used, without QUIC. Gzip responses are decoded incrementally with CRC/truncation checks; unsupported content encodings are rejected.

Green -> Network / TLS selects a persisted mode: Auto (default, TLS 1.2-1.3 negotiation), TLS 1.2 only, or TLS 1.3 only. Saved choices are retained. TLS 1.3 playback has been tested on the Samsung KU6000 / Tizen 2.4 and M5550 / Tizen 3 TVs listed in the main README. Forced modes have identical minimum and maximum versions. Certificate chains and hostnames are always verified; requests never fall back to the system stack. Mode changes apply to new requests; restart playback or the interface to replace existing requests.

Settings and shell diagnostics display the latest actually negotiated NaCl TLS separately for Interface/API and Video. DOM resource loads (scripts, styles, images), plain HTTP, and any direct non-MSE media source remain on the system stack. That stack does not expose its TLS version; it is shown as unknown and is not controlled by the NaCl mode. Synchronous HTTPS XHR is unsupported. Native responses are limited to 64 MiB per request, so media uses segments/ranges rather than an entire-file buffer. Redirects stay on HTTPS and remove authorization on a different origin. A TCP read failure during the TLS handshake is retried once in the original mode, before any HTTP request can have been sent. Certificate errors, TLS version failures and failures after the handshake are not retried.

The module's read-only `inspect()` diagnostics contain request IDs, parser byte counts and pending-operation flags only. URLs, headers, bodies, cookies and account credentials are not included in those diagnostics or the in-memory log.

Local version 2.3.11 adds a bounded in-memory DNS cache (120 seconds, up to 32 endpoints), three shared TLS configurations and up to 32 authenticated session entries (at most five minutes). Sessions and idle connections are separated by hostname, port and TLS mode. TLS 1.3 tickets are consumed once; expired peer certificates are not used to resume a cached session. No session cache is written to disk.

Up to four HTTP/1.1 connections can be kept idle for 20 seconds. Only completely framed responses without pending socket operations are eligible; close-delimited, aborted, malformed and failed responses close the connection. An idle-connection failure before response headers may be retried once on a fresh connection for GET/HEAD. POST requests are never replayed after HTTP transmission. Certificate verification and forced-version limits remain enabled.

The JavaScript dispatcher reserves capacity for media, limits telemetry to one active request and keeps capacity for API/history traffic. Media messages use blocks up to approximately 256 KiB; decoded response text and JSON are cached per XHR and invalidated on reopen. The in-memory log reports queue wait, handshake duration and whether an existing connection was reused. These changes have local build and synthetic-test coverage. Version 2.3.11 fixes a 2.3.10 startup stall: Mbed TLS can yield WANT_READ while processing a TLS 1.3 session ticket without scheduling socket I/O, so the reactor must schedule its own continuation. Startup and API connection reuse were verified on the TV; detailed playback and performance checks are pending.

Local version 2.3.13 prevents an empty write-flush callback from blocking that TLS continuation after a write completes. It also enforces the four-request media limit in the API selection pass, leaving two of the six total slots available for API/history traffic. TV validation of these fixes is pending.

Local version 2.3.14 patches player-action instances without replacing YouTube's component constructor. This prevents stale keyboard listeners from surviving a menu replacement and breaking right-arrow navigation. The Mini Player button is inserted into the settings button list while the native settings-popup action is preserved.

The player controls opened with Enter show the transport that delivered successful googlevideo media data, rather than the configured mode or an API connection. The indication is reset for a new media ID and ignores data from previous streams. If separately identified audio uses another transport, its value is also shown. System playback is shown as unknown.

Player indicators settings can hide the playback protocol (shown by default) and show SponsorBlock availability never, only when unavailable (default), or always. Both appear in the upper-right corner with the player controls. SponsorBlock status comes from the existing segment request for the current video, without additional probes. The request times out after ten seconds and is canceled when changing videos. A successful response without segments or HTTP 404 means available; network, HTTP and response parsing errors mean unavailable. Always mode also shows checking and disabled states.

## Verified behavior

Version 2.3.8 was tested on Samsung KU6000 with Tizen 2.4. Auto negotiated verified TLS 1.3 for YouTube API and video requests and verified TLS 1.2 for a TLS-1.2-only endpoint. Forced TLS 1.3 rejected that endpoint without falling back. Negotiation is per connection; one TLS 1.2 result does not downgrade other connections. Auto does not make a separate forced-TLS-1.2 attempt after a network failure.

The saved mode survived restarts. Playback, seeking, pause/resume, SponsorBlock skipping and authenticated history requests worked. Incorrect hostnames and self-signed certificates were rejected. Intermittent DNS failures and TCP resets were observed; long-session reliability and fresh QR sign-in have not been established.
