// connect(iframe) — talk to a YouTube embed over the wire the official widget
// API itself uses (postMessage `listening` → `infoDelivery` / `command`), without
// loading https://www.youtube.com/iframe_api. Works with www.youtube-nocookie.com,
// adds no third-party script, sets no cookie of its own.
//
// The embed must be created with `?enablejsapi=1`.
//
// Rules learned in production, each one a bug that shipped once:
//  - The player ignores a `listening` sent before its own script runs, so we keep
//    asking (every `askInterval`) until it answers. A fixed number of tries gives up
//    on exactly the slow embeds that need the most tries.
//  - Every `load` of the frame is a NEW player: the handshake restarts, and the
//    previous player's state (playing, last tick) is forgotten, or a stale
//    "playing" would judge the new one before it has said anything.
//  - A player can keep saying "playing" while its ticks stop; that is reported as
//    `stall`, and the next tick as `resume`.
//  - Never poll forever: a frame that never answers (blocked embed, extension) is
//    given up after `giveUpAfter` ms.

const YT_ORIGIN = /(^|\.)youtube(-nocookie)?\.com$/;

/**
 * @param {HTMLIFrameElement} frame  the embed, created with `?enablejsapi=1`
 * @param {object} [opts]
 * @param {string}  [opts.id]           id echoed by the player; defaults to frame.id or 'ytp'
 * @param {number}  [opts.askInterval]  ms between `listening` retries (500)
 * @param {number}  [opts.giveUpAfter]  ms before a silent player is given up (120000)
 * @param {number}  [opts.stallAfter]   ms without a tick while "playing" = stall (3000)
 * @param {number}  [opts.stallPoll]    ms between stall checks (2000)
 * @param {RegExp}  [opts.origin]       accepted message-origin hostnames
 * @param {Window}  [opts.win]          the window to listen on (tests)
 */
export function connect(frame, opts = {}) {
  const {
    id = frame.id || 'ytp',
    askInterval = 500,
    giveUpAfter = 120_000,
    stallAfter = 3_000,
    stallPoll = 2_000,
    origin = YT_ORIGIN,
    win = typeof window !== 'undefined' ? window : undefined,
  } = opts;
  if (!frame || !win) throw new TypeError('connect(frame): an iframe and a window are required');

  const listeners = new Map(); // event → Set<fn>
  const emit = (name, props = {}) => {
    for (const fn of listeners.get(name) ?? []) fn(props);
    for (const fn of listeners.get('*') ?? []) fn(name, props);
  };

  let ready = false; // the player has spoken at least once
  let asks = 0;
  let loads = 0;
  let lastTick = 0;
  let lastState = null; // unknown; YouTube's own UNSTARTED is -1
  let stalled = false;
  let epoch = 0; // bumped on every (re)handshake
  let answered = 0; // epoch of the last message received
  let askTimer = null;
  let stallTimer = null;
  let destroyed = false;

  const post = (msg) => {
    try {
      frame.contentWindow?.postMessage(JSON.stringify(msg), '*');
    } catch {}
  };

  const command = (func, args = []) => post({ event: 'command', func, args, id });

  // Ask until THIS player answers, whatever `ready` says about the previous one.
  const hello = () => {
    if (askTimer) clearInterval(askTimer);
    askTimer = null;
    const mine = ++epoch;
    const startedAt = Date.now();
    const ask = () => {
      if (destroyed || answered === mine || epoch !== mine) {
        clearInterval(askTimer);
        askTimer = null;
        return;
      }
      if (Date.now() - startedAt > giveUpAfter) {
        clearInterval(askTimer);
        askTimer = null;
        if (!ready) emit('gaveup', { asks, loads });
        return;
      }
      asks++;
      post({ event: 'listening', id, channel: 'widget' });
    };
    ask();
    if (answered !== mine) {
      askTimer = setInterval(ask, askInterval);
      askTimer.unref?.(); // node: never keep a process alive for this
    }
  };

  const onMessage = (e) => {
    if (destroyed) return;
    let host = '';
    try {
      host = new URL(e.origin).hostname;
    } catch {
      return;
    }
    if (!origin.test(host)) return;
    let data = e.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object') return;
    // Several players on one page each echo the id they were greeted with.
    if (data.id !== undefined && data.id !== null && String(data.id) !== String(id)) return;

    answered = epoch;
    if (!ready) {
      ready = true;
      emit('ready', { asks, loads });
    }
    const info = data.info;
    if (info && typeof info.playerState === 'number' && info.playerState !== lastState) {
      lastState = info.playerState;
      emit('state', { state: lastState });
    }
    const t = info && info.currentTime;
    if (typeof t === 'number') {
      if (stalled) {
        stalled = false;
        emit('resume', {
          gap_s: lastTick ? Math.round((Date.now() - lastTick) / 1000) : null,
          had_tick: lastTick > 0,
        });
      }
      lastTick = Date.now();
      emit('time', { t, state: lastState });
    }
  };

  const onLoad = () => {
    if (destroyed) return;
    loads++;
    emit('load', { n: loads, asks });
    // Whatever loaded is a new player (or the first one): forget any carried
    // state, or a stale "playing" would judge it before it has said anything.
    lastState = null;
    lastTick = 0;
    stalled = false;
    hello();
  };

  // The failure that looks like nothing: state says playing (1), ticks have stopped.
  const checkStall = () => {
    if (destroyed || !ready || stalled || lastState !== 1) return;
    // lastTick = 0: the player said "playing" but never sent a time — that is a
    // stall too, but with no gap to report (Date.now() - 0 is not a gap, it is 1970).
    const gap = lastTick ? Date.now() - lastTick : Infinity;
    if (gap > stallAfter) {
      stalled = true;
      emit('stall', { gap_s: lastTick ? Math.round(gap / 1000) : null, had_tick: lastTick > 0 });
    }
  };

  win.addEventListener('message', onMessage);
  frame.addEventListener('load', onLoad);
  stallTimer = setInterval(checkStall, stallPoll);
  stallTimer.unref?.();
  hello();

  return {
    /** subscribe; returns an unsubscribe function. `'*'` receives (name, props). */
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    get ready() {
      return ready;
    },
    /** last playerState seen (YouTube's numbers), null until the player says */
    get state() {
      return lastState;
    },
    get stalled() {
      return stalled;
    },
    get asks() {
      return asks;
    },
    get loads() {
      return loads;
    },
    command,
    seek(t, allowSeekAhead = true) {
      command('seekTo', [t, allowSeekAhead]);
    },
    play() {
      command('playVideo');
    },
    pause() {
      command('pauseVideo');
    },
    destroy() {
      destroyed = true;
      if (askTimer) clearInterval(askTimer);
      if (stallTimer) clearInterval(stallTimer);
      win.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      listeners.clear();
    },
  };
}
