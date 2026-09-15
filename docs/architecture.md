# Architecture

The Electron main process loads configuration, owns the tray and display window, exposes loopback TCP/UDP listeners, and serializes commands through a bounded queue. State revisions invalidate callbacks from superseded media loads and timers.

A BaseWindow contains two WebContentsViews: an interactive webpage and a local presentation overlay. Remote webpages cannot access the overlay's preload API. The renderer handles images, videos, thumbnail pages and the Empty page. A private media protocol validates paths and supports byte ranges for videos.

Each media layer is a separate CSS stacking context. Incoming decoded media animates over the outgoing layer, which is released afterward. Foreground video supplies a low-resolution blurred backdrop through frame callbacks, avoiding a second decoder.

Profiles are separated by configuration filename and port beneath the data directory. TCP frames commands using newlines or EOF; UDP uses datagram boundaries. Replies acknowledge dispatch, not completion of asynchronous rendering.

Windows is the current tested target. `--daemon` is a detached desktop launch, not a service. Linux window placement, tray support and always-on-top behavior remain unvalidated. Packaging creates a local portable folder and never publishes it.
