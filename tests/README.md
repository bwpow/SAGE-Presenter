# Tests

## Core

Run `pnpm test`. Tests cover command parsing, TCP framing, navigation, paths and configuration. No external media, FFmpeg, browser or network server is required.

## Desktop

Run on a graphical Windows desktop with Node.js, the installed Electron runtime, Playwright resolvable by Node, and FFmpeg with the `libx264` encoder. FFmpeg is used only to generate synthetic three-second videos. It is not included in the application or used at runtime.

To avoid changing the project's lockfile, install Playwright in an ignored tools directory:

```powershell
npm install --prefix work/test-tools --no-package-lock --no-save playwright
$env:NODE_PATH = (Resolve-Path work/test-tools/node_modules).Path
# If FFmpeg is not on PATH, set FFMPEG_PATH to your ffmpeg executable.
pnpm run test:desktop
```

These tests generate PNGs and H.264 MOV/MP4 files under `work/smoke/fixtures`, serve an interaction page on localhost, and use isolated configuration/data under `work/smoke`. No personal media or remote website is required. Ports 49781 and 49782 must be free. Tests open their own windows and tray icons and close them afterward.

The suite covers UDP/TCP, playback, interruption, fixed thumbnail pagination, cache reload, Empty-page rendering, separate instances and simulated display loss. Crossfades are checked using captured foreground pixels as well as layer state. Results and screenshots stay in ignored `work/`.

To test a locally packaged Windows executable:

```powershell
$env:PRESENTER_EXE = (Resolve-Path 'output/SAGE Presenter-win32-x64/SAGE Presenter.exe').Path
pnpm run test:desktop
```

`portable-launch.cjs` attaches a test debugger; no inspector hooks are added to the distributed application. Remove `PRESENTER_EXE` to return to development testing. `--test-window` is a test-only resizable-window option.

## Daemon

After locally packaging, run `pnpm run test:daemon` on Windows. It uses generated images, port 49783 and an isolated batch file/configuration under `work/daemon-test`. It checks prompt batch exit, continued TCP operation and reuse of the existing instance, then terminates only its own test process tree. Tray Close is covered by the desktop suite.

These tests do not establish physical HDMI reconnection, audible output routing, H.265 support or compatibility with every OS/graphics-driver combination.
