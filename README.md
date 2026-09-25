# SAGE Presenter

A portable desktop presenter for interactive webpages, images and videos, controlled from a Stream Deck or any local UDP/TCP client. Built with Electron and TypeScript for a laptop-and-external-display workflow.

**This application was fully vibe coded with GPT-6 Astra and GPT-6 Sol.** Its implementation was generated through conversational AI-assisted development. Contributions, reproducible bug reports and independent review are welcome.

The project is free and dedicated to the public domain under **CC0 1.0 Universal**. This repository currently provides source code only, with no GitHub releases or downloadable binaries.

## Features

- Borderless fullscreen on a selected display, with optional always-on-top behavior.
- Interactive webpages with mouse, keyboard and scrolling.
- Images and videos fitted without cropping, with a blurred background and short crossfades.
- Manual navigation, automatic slideshows, and a fixed 5×3 thumbnail grid with paging and clear selection.
- An Empty startup page with an optional logo.
- Local UDP and TCP commands; multiple instances with separate configurations, ports and browser profiles.
- Tray controls for displays, cache clearing, reloading and closing each instance.
- Portable application and configurable data directory; no installer, telemetry, updater, remote fonts or runtime downloads.

Webpages still require access to their server. Build dependencies require downloads or a populated local cache. Windows is the validated platform. Windows 10/11 compatibility is intended, but individual drivers, codecs and HDMI arrangements require testing. Linux packaging and desktop behavior remain unvalidated.

## Build from source

Use Node.js 22.12 or later and pnpm 11. From the repository directory:

```powershell
pnpm install --frozen-lockfile
pnpm run setup
Copy-Item config.example.json config.json
New-Item -ItemType Directory -Force media
pnpm test
pnpm start
```

Edit `config.json` for your setup. It is ignored by Git. The generic example uses monitor 1, localhost port 49731, `./media` for media and `./data` for runtime data. Relative configuration paths resolve beside the configuration file.

To create a local portable folder, run `pnpm run package`. The result is under the ignored `output/` directory. Packaging does not publish a release. On Windows x64, the folder is `output/SAGE Presenter-win32-x64/`. Keep the whole folder together; the EXE alone is insufficient. End users need neither Node.js nor pnpm.

Packaging includes a generic `config.json` from `config.example.json`, not your private development config or media. Create your own media directory and adjust that config. When rebuilding into an existing output folder, its configuration and user data are preserved.

## Launch and displays

From the portable application folder:

```powershell
& '.\SAGE Presenter.exe' --config '.\config.json'
& '.\SAGE Presenter.exe' --config '.\config.second.json' --daemon
& '.\SAGE Presenter.exe' --config '.\config.json' --list-displays
```

Without `--config`, the packaged executable reads `config.json` beside itself. Copy `config.second.example.json` for another instance and select another port. Each instance has its own tray icon and browser profile. Starting the same instance again brings it forward.

`--daemon` detaches from the terminal or batch file and returns promptly. The presentation, tray and listeners remain running in the current user's desktop session. It is not a Windows service. Successful launcher exit confirms process creation; configuration and socket initialization happen afterward in the child.

Presenter numbers the primary display first, then other displays by desktop position. These numbers may differ from Windows Display Settings. Use `--list-displays` or the tray's **Identify displays**. The default missing-monitor behavior hides the presentation until its display returns.

## Stream Deck and commands

For Command Sender, select **UDP**, address **127.0.0.1**, port **49731**. Put the command in **Command Pressed** and leave **Command Released** empty. Each UTF-8 UDP datagram is one command: **no newline or escape suffix is required**. A JSON reply is sent to the source address and port.

TCP is also available on the same numeric port. End each command with a line feed (`\n`); CRLF works too. Connections can carry multiple commands, and a final nonempty command at EOF is accepted. TCP replies are newline-delimited JSON. Both transports share the command queue. UDP has no delivery guarantee or automatic retry; avoid blindly retrying relative commands such as Next.

| Command | Effect |
| --- | --- |
| `URL "http://localhost:8080/"` | Show an interactive webpage |
| `Folder "slides"` | Open the first supported file in a folder under `mediaRoot` |
| `Folder "slides" "02.png"` | Start at a selected file |
| `AutoFolder "slides"` | Start automatic playback |
| `AutoFolder "slides" "intro.mp4"` | Start automatic playback at a selected file |
| `Thumbs "slides"` | Show folder thumbnails |
| `Thumbs "slides" "02.png"` | Show thumbnails with a selected file |
| `Next` / `Previous` | Navigate files or thumbnail selections, wrapping around |
| `Enter` | Toggle between media and its thumbnails |
| `Empty` | Stop playback and show the Empty page |
| `Clear` | Clear cache and reload current content |
| `Status` | Return instance, display and playback diagnostics |
| `Hide` | Hide this instance's presentation window to its tray icon; playback and listeners continue |
| `Resume` | Show a window hidden by Hide; do nothing if it is already shown |
| `Quit` | Close this instance cleanly, including its window, tray and listeners |

Examples are placeholders: supply your own server and media. Names are case-insensitive. Quote paths containing spaces; Windows backslashes are literal. Folder paths may be relative to `mediaRoot` or absolute inside it. Multiple URL buttons can point to different pages.

The included PowerShell helper sends TCP and adds the terminator:

```powershell
.\Send-Command.ps1 -Command 'Folder "slides"'
.\Send-Command.ps1 -Command 'Next'
.\Send-Command.ps1 -Port 49732 -Command 'Status'
```

A successful reply means accepted, not necessarily finished decoding/loading. New commands interrupt pending content changes. Invalid commands and unavailable folders preserve the current selection. Diagnostic replies and logs may contain paths; the audience view does not.

## Playback

Files use case-insensitive lexical sorting with a stable case-sensitive tie break. Use zero-padded filenames for numbered presentations. Subfolders are not scanned recursively. Manual mode holds images and plays videos once, holding the final frame. Automatic mode times decoded images and advances videos at their end event.

Thumbnails have 15 slots per page, with fewer occupied slots on the last page. Next/Previous changes pages automatically. Enter or a click opens the selection. Opening thumbnails pauses playback; returning resumes the preceding manual/automatic mode. Reselecting a video starts it from the beginning. Left/right arrow keys and Enter also navigate in media/thumbnail mode.

Webpages accept ordinary input. Presentation navigation commands do not alter the webpage. Returning to the currently loaded URL preserves its state; other URLs navigate the single retained web view.

Images: JPG/JPEG, PNG, WebP, GIF, BMP and AVIF. Video containers: MP4, MOV, M4V, WebM and OGV. Actual playback depends on the internal codecs. H.264 MOV/MP4 has been tested; H.265 remains unverified. No media conversion is performed.

The Empty page always appears at startup. Set `emptyImage` to a path or `""` for black. Its picture is centered at one image pixel per display pixel without resizing; oversized pictures extend beyond the screen. Pixel `(0,0)` supplies the background color, with transparency flattened onto black. Only the name and version appear as small text at the upper left. No logo or presentation media is bundled with the repository.

## Configuration

Restart after changing settings.

| Setting | Meaning |
| --- | --- |
| `instanceName` | Instance name in the tray |
| `monitor` | One-based Presenter display number |
| `displayId` | Optional Electron display ID, preferred over `monitor` |
| `alwaysOnTop` | Keep the borderless window above ordinary windows |
| `listenHost` | Must be `127.0.0.1` |
| `listenPort` | TCP/UDP port, 1024–65535; unique per instance |
| `emptyImage` | Config-relative or absolute image path; `""` for black |
| `mediaRoot` | Allowed media root, relative to the config or absolute |
| `dataFolder` | Writable base for profiles, caches and logs; default `./data` |
| `imageDurationSeconds` | Automatic image duration, 0.1–86400 seconds |
| `transitionMilliseconds` | Crossfade duration, 0–2000 ms |
| `fit` | Must be `contain` |
| `volume` | Media audio level, 0–1 |
| `mute` | Mute media and webpage audio |
| `missingMonitor` | `hide` waits for the display; `primary` uses the primary temporarily |

Profiles are stored under `<dataFolder>/instances/<instance-key>`. The key uses the configuration filename and port, so moving a portable folder preserves its profile; renaming the config or changing the port selects another profile. Logs are under each profile's `logs/` directory. `Status` includes resolved paths, process ID and daemon status.

Each tray offers **Show presentation**, **Identify displays**, **Display (this run)**, **Clear cache and reload**, and **Close**. Display changes from the tray last for that run. Cache clearing removes HTTP cache, Cache Storage, service workers and thumbnails, retaining cookies and page storage. It reloads the webpage, restarts media or refreshes the Empty picture. Other instances are unaffected.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md), [tests/README.md](tests/README.md) and [architecture notes](docs/architecture.md). Core tests need no presentation files or server. Desktop tests generate synthetic media and serve a webpage on localhost; they need a graphical desktop, Playwright and FFmpeg.

```text
src/                 Main process, renderer, protocol and shared types
assets/              UI and application icons
scripts/             Build and local packaging helpers
tests/               Core, desktop and daemon tests
docs/                Architecture and platform notes
config.example.json  Generic first-instance configuration
output/              Ignored local portable builds
```

There is no automated publishing or release workflow. Physical HDMI reconnection, audio routing, platform-specific codecs and Windows 10 hardware remain acceptance checks beyond automated tests. See [SECURITY.md](SECURITY.md) for the local-command trust model.

## License

Original project code, documentation and application assets are provided under [CC0 1.0 Universal](LICENSE), the [Creative Commons public-domain dedication](https://creativecommons.org/publicdomain/zero/1.0/). Third-party dependencies retain their licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Your media and loaded websites are not covered by this dedication.
