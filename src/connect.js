// connect(iframe) — the YouTube IFrame Player API's surface, over the wire the
// official widget itself uses (postMessage `listening` → `initialDelivery` /
// `infoDelivery` / `command`), without loading https://www.youtube.com/iframe_api.
// Works with www.youtube-nocookie.com, adds no third-party script, sets no cookie
// of its own. The embed must be created with `?enablejsapi=1`.
//
// Methods carry the official names (playVideo, seekTo, getDuration, …). Commands
// are posted; getters read a local copy of the player's `info`, which the embed
// sends in full once (`initialDelivery`) and then as patches (`infoDelivery`) —
// exactly what the official API does, so a getter is as fresh as the last tick.
//
// Rules learned in production, each one a bug that shipped once:
//  - The player ignores a `listening` sent before its own script runs, so we keep
//    asking (every `askInterval`) until it answers. A fixed number of tries gives up
//    on exactly the slow embeds that need the most tries.
//  - Every `load` of the frame is a NEW player: the handshake restarts, and the
//    previous player's info is forgotten, or a stale "playing" would judge the new
//    one before it has said anything.
//  - A player can keep saying "playing" while its ticks stop; that is reported as
//    `stall`, and the next tick as `resume`.
//  - Never poll forever: a frame that never answers (blocked embed, extension) is
//    given up after `giveUpAfter` ms.

const YT_ORIGIN = /(^|\.)youtube(-nocookie)?\.com$/;

/** YouTube's player states, the official numbers. */
export const PlayerState = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

// Commands exposed as methods. Anything else goes through `command(name, args)`;
// the embed lists what it accepts in `getApiInterface()`.
const COMMANDS = [
  'playVideo', 'pauseVideo', 'stopVideo', 'clearVideo',
  'mute', 'unMute', 'setVolume',
  'setPlaybackRate', 'setPlaybackQuality',
  'loadVideoById', 'cueVideoById', 'loadVideoByUrl', 'cueVideoByUrl',
  'loadPlaylist', 'cuePlaylist', 'nextVideo', 'previousVideo', 'playVideoAt',
  'setLoop', 'setShuffle', 'setSize', 'setOption',
];

// Getters answered from the local info copy: method name → info key.
const GETTERS = {
  getCurrentTime: 'currentTime',
  getDuration: 'duration',
  getPlayerState: 'playerState',
  getVolume: 'volume',
  isMuted: 'muted',
  getPlaybackRate: 'playbackRate',
  getAvailablePlaybackRates: 'availablePlaybackRates',
  getPlaybackQuality: 'playbackQuality',
  getAvailableQualityLevels: 'availableQualityLevels',
  getVideoData: 'videoData',
  getVideoUrl: 'videoUrl',
  getVideoEmbedCode: 'videoEmbedCode',
  getVideoLoadedFraction: 'videoLoadedFraction',
  getPlaylist: 'playlist',
  getPlaylistIndex: 'playlistIndex',
  getPlaylistId: 'playlistId',
  getApiInterface: 'apiInterface',
  getPlayerMode: 'playerMode',
  getMediaReferenceTime: 'mediaReferenceTime',
};

// info key → event emitted when it changes (besides the generic 'info').
const CHANGE_EVENTS = {
  playerState: 'stateChange',
  playbackRate: 'playbackRateChange',
  playbackQuality: 'playbackQualityChange',
  volume: 'volumeChange',
  muted: 'volumeChange',
};
const DERIVED = new Set(Object.values(CHANGE_EVENTS));

/**
 * @param {HTMLIFrameElement} frame  the embed, created with `?enablejsapi=1`
 * @param {object} [opts]
 * @param {string}  [opts.id]           id echoed by the player; defaults to frame.id or 'ytp'
 * @param {number}  [opts.askInterval]  ms between `listening` retries (500)
 * @param {number}  [opts.giveUpAfter]  ms before a silent player is given up (120000)
 * @param {number}  [opts.stallAfter]   ms without a tick while playing = stall (3000)
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
  let info = {}; // the player's info, merged from initialDelivery + infoDelivery
  let asks = 0;
  let loads = 0;
  let lastTick = 0;
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
        if (!ready) emit('gaveUp', { asks, loads });
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

  const applyInfo = (patch) => {
    // The first fill (initialDelivery, or whatever arrives first) is the player's
    // starting state, not a change: it emits `info` only — like the official API,
    // which announces it through onReady and fires onStateChange from then on.
    const first = Object.keys(info).length === 0;
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (info[k] !== v) changed.push(k);
      info[k] = v;
    }
    if (!changed.length) return;
    emit('info', { changed, info, first });
    if (first) return;
    const fired = new Set();
    for (const k of changed) {
      const ev = CHANGE_EVENTS[k];
      if (!ev || fired.has(ev)) continue;
      fired.add(ev);
      if (ev === 'stateChange') emit(ev, { state: info.playerState });
      else if (ev === 'volumeChange') emit(ev, { volume: info.volume, muted: info.muted });
      else emit(ev, { [k]: info[k] });
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
    const ev = data.event;
    if (data.info && typeof data.info === 'object' && (ev === undefined || ev === 'initialDelivery' || ev === 'infoDelivery')) {
      const hadTime = typeof data.info.currentTime === 'number';
      applyInfo(data.info);
      if (hadTime) {
        if (stalled) {
          stalled = false;
          emit('resume', {
            gap_s: lastTick ? Math.round((Date.now() - lastTick) / 1000) : null,
            had_tick: lastTick > 0,
          });
        }
        lastTick = Date.now();
        emit('timeUpdate', { t: info.currentTime, state: info.playerState ?? null });
      }
      return;
    }
    // The embed's own events: onError, onApiChange, … (onReady is `ready` above; the
    // *Change events are derived from info, where the values actually arrive).
    if (typeof ev === 'string' && ev.startsWith('on') && ev !== 'onReady') {
      const name = ev[2].toLowerCase() + ev.slice(3);
      if (!DERIVED.has(name)) emit(name, { data: data.info ?? null });
    }
  };

  const onLoad = () => {
    if (destroyed) return;
    loads++;
    emit('load', { n: loads, asks });
    // Whatever loaded is a new player (or the first one): forget any carried
    // info, or a stale "playing" would judge it before it has said anything.
    info = {};
    lastTick = 0;
    stalled = false;
    hello();
  };

  // The failure that looks like nothing: state says playing, ticks have stopped.
  const checkStall = () => {
    if (destroyed || !ready || stalled || info.playerState !== PlayerState.PLAYING) return;
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

  const player = {
    /** subscribe; returns an unsubscribe function. `'*'` receives (name, props). */
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    /** send any IFrame API function by name (see getApiInterface()) */
    command,
    /** seekTo(seconds, allowSeekAhead = true) */
    seekTo(seconds, allowSeekAhead = true) {
      command('seekTo', [seconds, allowSeekAhead]);
    },
    /** the merged info object the getters read — for anything without a getter */
    getInfo() {
      return info;
    },
    get ready() {
      return ready;
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
    destroy() {
      destroyed = true;
      if (askTimer) clearInterval(askTimer);
      if (stallTimer) clearInterval(stallTimer);
      win.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      listeners.clear();
    },
  };
  for (const name of COMMANDS) player[name] = (...args) => command(name, args);
  for (const [name, key] of Object.entries(GETTERS)) player[name] = () => info[key];
  return player;
}
