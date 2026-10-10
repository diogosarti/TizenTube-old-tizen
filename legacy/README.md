# Building and debugging the Old Tizen widget

The released application uses `widget/index.html` and a local `player.html` frame. It retrieves YouTube TV HTML directly, inserts compatibility scripts and the TizenTube bundle, then writes the document into that frame. The service-based prototype is not included in the widget.

## Build and sign

From the repository root:

```text
npm --prefix mods install
npm --prefix legacy install
npm --prefix legacy test
npm --prefix legacy run build
tizen package -t wgt -s YOUR_CERTIFICATE_PROFILE -o artifacts/2.2.0/signed -- legacy/dist/widget-2.2.0
```

The build checks ES5 syntax, rejects source maps and WebKit-incompatible function declarations inside blocks, checks the manifest version and refuses unexpected files in a reused stage. Previous version directories are retained.

Output files are the unsigned WGT, a release ZIP containing a WGT requiring signing, and the stage for the Samsung packager. The ZIP excludes signatures, certificates, tools, dependencies and debug metadata. The packaged third-party notices also include dependency license texts.

The application ID remains `TTIconT029.IconTest` and the package ID remains `TTIconT029` to permit updates of the validated installation without deleting its data.

## Install and launch

Replace `TV_IP` with the TV address:

```text
sdb connect TV_IP:26101
tizen install -n TizenTube-old-tizen.wgt -s TV_IP:26101 -- artifacts/2.2.0/signed
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

HTTPS uses the TV's system networking stack. The WebKit API does not report the negotiated TLS version. The widget neither implements TLS 1.3 nor runs an HTTP log receiver.
