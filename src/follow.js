// follow(rowsEl, player) — an EXAMPLE built on connect(): keep a list of timed
// rows (a transcript) following the player. Importable as `yt-follow/follow`;
// the core package is connect() alone, and this is what an app on top looks like.
// It keeps a list of timed rows following a connected player: the current row gets a class, the PANEL (never the page) scrolls to it
// when it changes, a click on a row's seek control jumps the video there, and a
// reader's own gesture over the panel switches following off.
//
// Rules learned in production, each one a bug that shipped once:
//  - Scroll only when the current ROW changes. Ticks arrive several times a
//    second; scrolling on each one fought its own smooth animation and, by
//    refreshing a "we did this" timestamp continuously, made the reader's scroll
//    indistinguishable from ours — follow could never be broken.
//  - Scroll the panel directly (`el.scrollTo`), not `scrollIntoView`: the latter
//    also scrolls the PAGE and unpins the video the reader is watching alongside.
//  - Break follow on a GESTURE (wheel / touchmove / keys), never on the `scroll`
//    event — our own scroll fires the same event, and telling them apart by
//    timing fails while the player ticks continuously.
//  - A gesture is reported with whether the panel HAD ROOM to scroll that way
//    (`room`); a wheel over a panel already at its end scrolls the page instead,
//    and if that turns out to be common the listener is too eager, not the reader.

const KEYS = ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/**
 * @param {HTMLElement} rowsEl   the scrolling panel that contains the rows
 * @param {ReturnType<import('./connect.js').connect>} player
 * @param {object} [opts]
 * @param {string}  [opts.rowSelector]   rows ('[data-t]'); ones with an empty value are skipped
 * @param {string}  [opts.timeAttr]      attribute holding the row's start second ('data-t')
 * @param {string}  [opts.seekSelector]  click target inside a row that seeks ('[data-seek]')
 * @param {string}  [opts.nowClass]      class on the current row ('is-now')
 * @param {number}  [opts.tolerance]     seconds a row may lead the player and still count (0.25)
 * @param {number}  [opts.topOffset]     px above the row when scrolled to it (6)
 * @param {'smooth'|'auto'|'instant'} [opts.behavior]  panel scroll behavior ('smooth')
 * @param {string[]} [opts.keys]         keys that break follow
 * @param {boolean} [opts.enableSeekOnReady] clear `disabled` on seek controls when the player answers (true)
 * @param {(now:number, row:Element|null)=>void} [opts.onTick]    every tick
 * @param {(row:Element|null, now:number)=>void} [opts.onChange]  when the current row changes
 * @param {(on:boolean, reason:string, extra:object)=>void} [opts.onFollow]
 * @param {(t:number, row:Element|null)=>void} [opts.onSeek]
 */
export function follow(rowsEl, player, opts = {}) {
  const {
    rowSelector = '[data-t]',
    timeAttr = 'data-t',
    seekSelector = '[data-seek]',
    nowClass = 'is-now',
    tolerance = 0.25,
    topOffset = 6,
    behavior = 'smooth',
    keys = KEYS,
    enableSeekOnReady = true,
    onTick,
    onChange,
    onFollow,
    onSeek,
  } = opts;
  if (!rowsEl || !player) throw new TypeError('follow(rowsEl, player): both are required');

  const rows = [...rowsEl.querySelectorAll(rowSelector)]
    .map((el) => ({ el, t: Number(el.getAttribute(timeAttr)) }))
    .filter((r) => r.el.getAttribute(timeAttr) !== '' && Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  let now = 0;
  let following = true;
  let scrolledTo = null; // the row we last scrolled to
  let current = null;
  const offs = [];

  const currentRow = () => {
    let found = null;
    for (const r of rows) {
      if (r.t <= now + tolerance) found = r.el;
      else break;
    }
    return found;
  };

  const paint = (scroll) => {
    const cur = currentRow();
    if (cur !== current) {
      for (const r of rows) r.el.classList.toggle(nowClass, r.el === cur);
      current = cur;
      onChange?.(cur, now);
    }
    onTick?.(now, cur);
    if (scroll && cur && cur !== scrolledTo) {
      scrolledTo = cur;
      rowsEl.scrollTo({ top: Math.max(0, cur.offsetTop - topOffset), behavior });
    }
  };

  const setFollow = (on, reason = 'api', extra = {}) => {
    const changed = on !== following;
    following = on;
    if (!on) scrolledTo = null;
    if (changed) onFollow?.(on, reason, extra);
    if (on) paint(true);
  };

  // Could the panel itself have scrolled in this direction? (null: no direction)
  const room = (dy) => {
    if (dy > 0) return rowsEl.scrollTop + rowsEl.clientHeight < rowsEl.scrollHeight - 1;
    if (dy < 0) return rowsEl.scrollTop > 0;
    return null;
  };

  const seekTo = (t, row = null, reason = 'seek') => {
    now = t;
    player.seekTo(t, true);
    player.playVideo();
    setFollow(true, reason);
    onSeek?.(t, row);
  };

  // ── player → rows ──
  offs.push(
    player.on('timeUpdate', ({ t }) => {
      now = t;
      paint(following);
    })
  );
  if (enableSeekOnReady) {
    const enable = () => {
      for (const b of rowsEl.querySelectorAll(seekSelector)) b.disabled = false;
    };
    if (player.ready) enable();
    else offs.push(player.on('ready', enable));
  }

  // ── reader → player ──
  const onClick = (e) => {
    const btn = e.target.closest?.(seekSelector);
    if (!btn || !player.ready) return;
    const row = btn.closest(rowSelector);
    const t = Number(row?.getAttribute(timeAttr));
    if (!Number.isFinite(t)) return;
    seekTo(t, row, 'seek');
  };
  let touchY = null;
  const onTouchStart = (e) => {
    touchY = e.touches?.[0]?.clientY ?? null;
  };
  const onWheel = (e) => {
    if (following && player.ready) {
      const dy = Math.round(e.deltaY);
      setFollow(false, 'wheel', { dy, room: room(dy) });
    }
  };
  const onTouchMove = (e) => {
    if (!(following && player.ready)) return;
    const y = e.touches?.[0]?.clientY;
    // finger down = content up = scrolling toward the end (positive dy)
    const dy = touchY != null && y != null ? Math.round(touchY - y) : 0;
    setFollow(false, 'touchmove', { dy, room: room(dy) });
  };
  const onKeyDown = (e) => {
    if (keys.includes(e.key) && following && player.ready) setFollow(false, 'keydown', { key: e.key });
  };
  rowsEl.addEventListener('click', onClick);
  rowsEl.addEventListener('touchstart', onTouchStart, { passive: true });
  rowsEl.addEventListener('wheel', onWheel, { passive: true });
  rowsEl.addEventListener('touchmove', onTouchMove, { passive: true });
  rowsEl.addEventListener('keydown', onKeyDown);

  return {
    rows: rows.map((r) => r.el),
    get now() {
      return now;
    },
    get following() {
      return following;
    },
    get current() {
      return current;
    },
    currentRow,
    setFollow,
    /** seek the player and resume following (what a row click does) */
    seekTo: (t, reason = 'api') => seekTo(t, null, reason),
    room,
    destroy() {
      for (const off of offs) off();
      rowsEl.removeEventListener('click', onClick);
      rowsEl.removeEventListener('touchstart', onTouchStart);
      rowsEl.removeEventListener('wheel', onWheel);
      rowsEl.removeEventListener('touchmove', onTouchMove);
      rowsEl.removeEventListener('keydown', onKeyDown);
    },
  };
}
