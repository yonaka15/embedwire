// A YouTube embed stand-in: an iframe whose contentWindow records what the page
// posts to it, and a helper that answers the way the real player does (a JSON
// string, from a youtube-nocookie origin, echoing the id).
import { JSDOM } from 'jsdom';

export function setup({ id = 'ytp', origin = 'https://www.youtube-nocookie.com' } = {}) {
  const dom = new JSDOM(`<!doctype html><body><iframe id="${id}"></iframe></body>`, {
    url: 'https://example.test/posts/x/',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const frame = win.document.getElementById(id);
  const posted = [];
  // jsdom gives an iframe a contentWindow; replace postMessage so we can read it.
  Object.defineProperty(frame, 'contentWindow', {
    value: {
      postMessage: (msg) => posted.push(typeof msg === 'string' ? JSON.parse(msg) : msg),
    },
  });
  const say = (data, o = origin) => {
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data: typeof data === 'string' ? data : JSON.stringify({ id, ...data }),
        origin: o,
      })
    );
  };
  const tick = (t, state = 1) => say({ event: 'infoDelivery', info: { currentTime: t, playerState: state } });
  // what a real embed sends first: the whole info object (measured 2026-08-31)
  const init = (extra = {}) =>
    say({
      event: 'initialDelivery',
      info: {
        apiInterface: ['playVideo', 'pauseVideo', 'seekTo', 'getDuration'],
        duration: 635,
        videoData: { video_id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', author: '', isPlayable: true },
        availablePlaybackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
        volume: 100,
        muted: false,
        playbackRate: 1,
        playerState: 5,
        playbackQuality: 'unknown',
        videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        ...extra,
      },
    });
  const reload = () => frame.dispatchEvent(new win.Event('load'));
  return { dom, win, frame, posted, say, tick, init, reload };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
