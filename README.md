# yt-follow

Talk to a YouTube embed over the wire the official widget API itself uses — raw
`postMessage` (`listening` → `infoDelivery` / `command`) — **without loading
`https://www.youtube.com/iframe_api`**, and keep a transcript following the video.

- Works with `www.youtube-nocookie.com`; adds no third-party script, sets no cookie of its own.
- Zero dependencies, ~300 lines of plain ESM, two functions.
- Hardened against the failures that only show up in production: a slow embed, a
  frame that reloads under you, a player that says "playing" while its ticks stop.

```html
<iframe id="ytp" src="https://www.youtube-nocookie.com/embed/VIDEO_ID?enablejsapi=1"></iframe>

<ol data-rows>
  <li data-t="0"><button data-seek disabled>0:00</button> First line…</li>
  <li data-t="4.2"><button data-seek disabled>0:04</button> Second line…</li>
</ol>

<script type="module">
  import { connect, follow } from 'yt-follow';
  const player = connect(document.getElementById('ytp'));
  const f = follow(document.querySelector('[data-rows]'), player);
</script>
```

That is the whole integration. The current line gets `class="is-now"`, the list
(not the page) scrolls to it when it changes, a click on a timestamp seeks the
video, and a wheel / touch / arrow key over the list stops following until the
reader asks for it again (`f.setFollow(true)`).

`?enablejsapi=1` on the embed URL is the only requirement.

## Install

```
npm install yt-follow
```
or straight from GitHub: `npm install github:yonaka15/yt-follow`.

## `connect(iframe, opts?)` — the wire

Returns a player handle. Nothing is loaded; the handshake is a `listening`
message sent every `askInterval` ms until the player answers.

| option | default | |
|---|---|---|
| `id` | `iframe.id` or `'ytp'` | id echoed by the player (several players on a page are told apart by it) |
| `askInterval` | `500` | ms between `listening` retries |
| `giveUpAfter` | `120000` | ms before a silent player is given up (`gaveup`) |
| `stallAfter` | `3000` | ms without a tick while "playing" before `stall` |
| `stallPoll` | `2000` | ms between stall checks |
| `origin` | `/(^|\.)youtube(-nocookie)?\.com$/` | accepted message-origin hostnames |

```js
player.on('ready',  ({ asks, loads }) => …)   // first message from the player
player.on('time',   ({ t, state }) => …)      // currentTime, several times a second while playing
player.on('state',  ({ state }) => …)         // YouTube's playerState, on change
player.on('load',   ({ n, asks }) => …)       // the iframe's load event; n ≥ 2 = it reloaded
player.on('stall',  ({ gap_s, had_tick }) => …) // "playing" but no tick for stallAfter
player.on('resume', ({ gap_s, had_tick }) => …)
player.on('gaveup', ({ asks, loads }) => …)
player.on('*', (name, props) => …)            // everything, for your telemetry
player.seek(t, allowSeekAhead = true); player.play(); player.pause();
player.command('setVolume', [50]);            // any IFrame API function by name
player.ready; player.state; player.stalled; player.destroy();
```

`on()` returns an unsubscribe function.

## `follow(rowsEl, player, opts?)` — the transcript

`rowsEl` is the scrolling container. Rows are `[data-t]` elements (an empty
`data-t` is skipped — a speaker-list row, say) sorted by their start second.

| option | default | |
|---|---|---|
| `rowSelector` / `timeAttr` | `'[data-t]'` / `'data-t'` | how rows are found and timed |
| `seekSelector` | `'[data-seek]'` | click target inside a row that seeks; `disabled` is cleared when the player answers |
| `nowClass` | `'is-now'` | class on the current row |
| `tolerance` | `0.25` | seconds a row may lead the player and still count as current |
| `topOffset` / `behavior` | `6` / `'smooth'` | how the panel scrolls to the row |
| `keys` | PageUp/Down, Arrow Up/Down, Home, End | keys that break follow |
| `onTick(now, row)` | | every tick |
| `onChange(row, now)` | | when the current row changes |
| `onFollow(on, reason, extra)` | | `reason`: `wheel` `touchmove` `keydown` `seek` or yours; `extra.room` says whether the panel could have scrolled that way |
| `onSeek(t, row)` | | after a seek |

```js
f.setFollow(true, 'jump');   // resume following (and scroll to the current row)
f.seekTo(93);                // what a timestamp click does
f.following; f.now; f.current; f.rows; f.destroy();
```

## Why these rules (each one shipped as a bug first)

- **Keep asking until the player answers.** The embed ignores a `listening` sent
  before its own script runs. A fixed number of tries gives up on exactly the
  slow embeds that need the most — measured on a live site with +8 s latency on
  the YouTube hosts: the transcript never connected, and one more `listening`
  sent by hand connected it at once. YouTube's own widget polls with no cap.
- **Every `load` is a new player.** The handshake restarts and the previous
  player's "playing" / last tick are forgotten, or they would judge the new one.
- **Scroll only when the current row changes.** Ticks arrive several times a
  second; scrolling on each fought its own smooth animation and made the
  reader's scroll indistinguishable from ours.
- **Scroll the panel, not the page.** `scrollIntoView` also scrolls the page and
  unpins the video the reader is watching alongside.
- **Break follow on a gesture, never on `scroll`.** Our own scroll fires the same
  event, and telling them apart by timing fails while the player ticks.
- **"Playing" with no ticks is a failure that looks like nothing.** It is
  reported (`stall`) instead of freezing silently under a label that says
  "following".

## What it is not

Not a player wrapper — for playlists, quality, captions, use the official IFrame
API. Not a transcript editor or renderer — bring your own rows. The wire is the
one YouTube's `widgetapi.js` speaks; it is undocumented, and if YouTube changes
it this breaks together with every page that uses the official API's transport.

## Development

```
npm test          # node --test, jsdom, a fake player that answers over postMessage
open demo/index.html  # serve the repo root (any static server) and open /demo/
```

MIT © yonaka15
