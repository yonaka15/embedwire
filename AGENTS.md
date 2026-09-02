# embedwire — AGENTS.md

Zero runtime dependencies, plain ESM. **The package is `connect()`** — the IFrame
Player API's methods/getters/events over the embed's own postMessage wire
(`listening` → `initialDelivery` / `infoDelivery`, `command`) without loading
`iframe_api`. `src/follow.js` (`embedwire/follow`) is an EXAMPLE built on it — a
transcript that follows the player — kept importable and tested because the first
consumer uses it. README.md is the API reference; this file is for changing the code.

Owner direction (2026-08-31): mirror the official reference — core API in the
package, UI (transcript follow etc.) as examples. Method and event names follow
the official ones (`playVideo`, `getDuration`, `stateChange`); do not invent
aliases (`seek`/`play` were removed in 0.2.0).

## Guardrails

- **The wire is YouTube's, not ours.** Every message shape here was observed on a real
  embed — what the player widget sends and what it answers. Do not "improve" a message; verify
  against a real embed (`npm run demo` → `/examples/player.html`) before merging a
  change to `connect.js`. The unit tests use a fake player and cannot catch a wire
  regression. Measured 2026-08-31 on a nocookie embed: the player sends
  `initialDelivery` (full info: `apiInterface` (60+ names), `duration`, `videoData`,
  `volume`, `muted`, `playbackRate`, `availablePlaybackRates`, `playerState`, …), then
  `onReady`, then `infoDelivery` patches (`currentTime`, `playerState`,
  `playbackQuality`, `videoLoadedFraction`, …). There is NO `onStateChange` message —
  the official API derives it from `playerState`, and so do we (`CHANGE_EVENTS`).
- **Getters never round-trip.** They read the merged `info`; the official API does
  the same. A getter that posts a command and awaits an answer would be a different
  design — do not add one.
- **Each rule in the file headers shipped as a bug first.** Keep asking until
  answered (a fixed try count gave up on slow embeds); every `load` is a new player;
  scroll only on row change; scroll the panel not the page; break follow on a
  gesture never on `scroll`; "playing" with no ticks is a `stall`. Removing one
  re-ships its bug — the README's "Why these rules" section is the record.
- ⭐ **A field added "in case it matters" has to be READ, or it decides nothing.**
  `room` shipped in 0.2.0 with a note saying the listener was too eager if
  `room: false` turned out to be common. Nobody looked for two versions. When it
  was finally measured on a live site (2026-09-02, 66 breaks / 60 readers) it was
  35 % of every break — 31 % of mobile swipes — and following came back for only
  20 % of the readers who lost it. 0.4.0 breaks on `room: true` alone. The rule
  this leaves behind: **ignoring an input must stay observable** (`onGesture`
  fires with `broke: false`), because a listener that silently does nothing looks
  identical whether it is right or wrong.
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
| `examples/player.html` | the core on a real `youtube-nocookie` embed: every method as a button, getters live — the wire test |
| `examples/transcript.html` | the follow example on the same embed |
| `examples/transcript-demo.gif` | README recording of `transcript.html` on Big Buck Bunny (CC BY; 3.1 MB — keep it about there; the owner chose it over a recording of a real comedy act) |

## Verifying against the real embed

```
npm run demo                                   # http.server on 127.0.0.1:4330
# open /examples/transcript.html — window.player / window.f are exposed
player.mute(); player.playVideo()              # autoplay needs mute without a gesture
f.seekTo(120)                                  # row 120 becomes current, panel scrolls
fr = document.getElementById('ytp'); fr.src = fr.src   # loads → 2, ready stays true, no stall
```

Expected on 2026-08-31: connected after ~3 `listening`s (initial, +500 ms, one more
on the frame's `load`); ticks ~4/s while playing; state 5 (cued) after a reload.

## Release

`npm test` green → bump `package.json` version → `git tag vX.Y.Z` → push → `gh release
create` → `npm publish`. First consumer: warakeru.jugoya.ai
(`site/src/pages/posts/[...slug].astro`) pins the tag as an https tarball
(`https://github.com/yonaka15/embedwire/archive/refs/tags/vX.Y.Z.tar.gz` — the
`github:` shorthand resolves to `git+ssh://` in a lockfile and Vercel has no ssh) and
maps `on('*')` to its own telemetry names. Bump that pin when you tag.
