# yt-follow — AGENTS.md

Two plain-ESM functions, zero runtime dependencies. `src/connect.js` speaks the
undocumented postMessage wire of a YouTube embed (`listening` → `infoDelivery`,
`command`) without loading `iframe_api`; `src/follow.js` keeps a list of timed
rows following that player. README.md is the API reference; this file is for
changing the code.

## Guardrails

- **The wire is YouTube's, not ours.** Every message shape here was taken from what
  `widgetapi.js` sends and what the embed answers. Do not "improve" a message; verify
  against a real embed (`demo/`, served from the repo root — `python3 -m http.server`)
  before merging a change to `connect.js`. The unit tests use a fake player and
  cannot catch a wire regression.
- **Each rule in the file headers shipped as a bug first.** Keep asking until
  answered (a fixed try count gave up on slow embeds); every `load` is a new player;
  scroll only on row change; scroll the panel not the page; break follow on a
  gesture never on `scroll`; "playing" with no ticks is a `stall`. Removing one
  re-ships its bug — the README's "Why these rules" section is the record.
- **No third-party script, no cookie, no network** — that is the reason this exists
  next to the official IFrame API. A PR that adds a dependency or a fetch is a
  different library.
- **Node timers are `unref()`ed** (`?.()`-guarded — a browser returns a number). A
  test that hangs the runner is a timer someone forgot; `destroy()` clears them all.
- `lastState` is `null` until the player speaks — YouTube's own UNSTARTED is `-1`,
  so `-1` cannot mean "unknown".

## Layout

| | |
|---|---|
| `src/connect.js` | the wire: handshake, message parsing, stall detection, commands |
| `src/follow.js` | rows ↔ player: current row, panel scroll, gestures, seek clicks |
| `test/fake-player.js` | jsdom + an iframe whose `contentWindow.postMessage` is recorded; `say()`/`tick()`/`reload()` answer like the embed |
| `test/*.test.js` | `npm test` (`node --test`), no browser |
| `demo/index.html` | a real `youtube-nocookie` embed; the only wire test |

## Verifying against the real embed

```
python3 -m http.server 4330 --bind 127.0.0.1   # from the repo root
# open http://127.0.0.1:4330/demo/ — window.player / window.f are exposed
player.command('mute'); player.play()          # autoplay needs mute without a gesture
f.seekTo(120)                                  # row 120 becomes current, panel scrolls
fr = document.getElementById('ytp'); fr.src = fr.src   # loads → 2, ready stays true, no stall
```

Expected on 2026-08-31: connected after ~3 `listening`s (initial, +500 ms, one more
on the frame's `load`); ticks ~4/s while playing; state 5 (cued) after a reload.

## Release

`npm test` green → bump `package.json` version → `git tag vX.Y.Z` → push → `npm publish`
(the consumer can also pin `github:yonaka15/yt-follow#vX.Y.Z`). First consumer:
warakeru.jugoya.ai (`site/src/pages/posts/[...slug].astro`), which maps `on('*')`
to its own telemetry names.
