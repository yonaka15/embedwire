import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/connect.js';
import { follow } from '../src/follow.js';
import { setup } from './fake-player.js';

function page(n = 5) {
  const s = setup();
  const { win } = s;
  const ol = win.document.createElement('ol');
  ol.setAttribute('data-rows', '');
  for (let i = 0; i < n; i++) {
    const li = win.document.createElement('li');
    li.className = 'row';
    li.setAttribute('data-t', String(i * 10));
    li.innerHTML = `<button data-seek disabled>${i}</button> line ${i}`;
    Object.defineProperty(li, 'offsetTop', { value: i * 40 });
    ol.appendChild(li);
  }
  // a cast row with no time is skipped
  const cast = win.document.createElement('li');
  cast.className = 'row';
  cast.setAttribute('data-t', '');
  ol.prepend(cast);
  win.document.body.appendChild(ol);
  const scrolls = [];
  ol.scrollTo = (o) => scrolls.push(o);
  Object.defineProperties(ol, {
    scrollTop: { value: 0, writable: true },
    clientHeight: { value: 100 },
    scrollHeight: { value: 200 },
  });
  const player = connect(s.frame, { win, askInterval: 1e6 });
  return { ...s, ol, scrolls, player };
}

test('rows skip empty times; seek buttons enable on ready', () => {
  const { ol, player, tick } = page();
  const f = follow(ol, player);
  assert.equal(f.rows.length, 5);
  assert.ok([...ol.querySelectorAll('[data-seek]')].every((b) => b.disabled));
  tick(0);
  assert.ok([...ol.querySelectorAll('[data-seek]')].every((b) => !b.disabled));
  f.destroy();
  player.destroy();
});

test('current row moves with time (tolerance) and the panel scrolls only on change', () => {
  const { ol, player, tick, scrolls } = page();
  const changes = [];
  const f = follow(ol, player, { onChange: (row) => changes.push(row?.getAttribute('data-t')) });
  tick(9.8); // within 0.25 s of row 10 → row 10
  assert.equal(f.current.getAttribute('data-t'), '10');
  assert.equal(scrolls.length, 1);
  assert.deepEqual(scrolls[0], { top: 40 - 6, behavior: 'smooth' });
  tick(9.9);
  tick(12);
  assert.equal(scrolls.length, 1, 'same row: no more scrolling');
  tick(21);
  assert.equal(scrolls.length, 2);
  assert.deepEqual(changes, ['10', '20']);
  f.destroy();
  player.destroy();
});

test('a wheel over the panel breaks follow and reports room; jump back resumes and scrolls', () => {
  const { win, ol, player, tick, scrolls } = page();
  const fol = [];
  const f = follow(ol, player, { onFollow: (on, reason, extra) => fol.push([on, reason, extra]) });
  tick(0);
  ol.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 120 }));
  assert.equal(f.following, false);
  assert.deepEqual(fol, [[false, 'wheel', { dy: 120, room: true }]]);
  tick(11);
  assert.equal(f.current.getAttribute('data-t'), '10', 'still paints');
  const n = scrolls.length;
  assert.equal(n, 1, 'but does not scroll');
  f.setFollow(true, 'jump');
  assert.equal(scrolls.length, 2, 'resuming scrolls to the current row');
  assert.deepEqual(fol[1], [true, 'jump', {}]);
  // at the end of the panel a downward wheel has no room
  ol.scrollTop = 100;
  ol.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 50 }));
  assert.equal(fol[2][2].room, false);
  f.destroy();
  player.destroy();
});

test('touchmove direction and keys break follow; scroll event does not', () => {
  const { win, ol, player, tick } = page();
  const fol = [];
  const f = follow(ol, player, { onFollow: (on, r, x) => fol.push([r, x]) });
  tick(0);
  ol.dispatchEvent(new win.Event('scroll'));
  assert.equal(f.following, true, 'scroll alone is not a gesture');
  const touch = (type, y) => {
    const e = new win.Event(type, { bubbles: true });
    e.touches = [{ clientY: y }];
    ol.dispatchEvent(e);
  };
  touch('touchstart', 300);
  touch('touchmove', 250); // finger up 50px → content toward the end
  assert.deepEqual(fol[0], ['touchmove', { dy: 50, room: true }]);
  f.setFollow(true);
  ol.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'PageDown' }));
  assert.deepEqual(fol[2], ['keydown', { key: 'PageDown' }]);
  ol.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a' }));
  assert.equal(fol.length, 3, 'other keys ignored');
  f.destroy();
  player.destroy();
});

test('clicking a seek control seeks, plays and resumes follow; ignored before ready', () => {
  const { win, ol, player, tick, posted } = page();
  const seeks = [];
  const f = follow(ol, player, { onSeek: (t) => seeks.push(t) });
  const btn = ol.querySelectorAll('[data-seek]')[3];
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(seeks.length, 0, 'not ready yet');
  tick(0);
  f.setFollow(false, 'wheel');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(seeks, [30]);
  assert.equal(f.following, true);
  assert.equal(f.now, 30);
  const cmds = posted.filter((m) => m.event === 'command').map((c) => c.func);
  assert.deepEqual(cmds, ['seekTo', 'playVideo']);
  assert.equal(f.current.getAttribute('data-t'), '30');
  f.destroy();
  player.destroy();
});

test('gestures do nothing before the player is ready', () => {
  const { win, ol, player } = page();
  const fol = [];
  const f = follow(ol, player, { onFollow: (on) => fol.push(on) });
  ol.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 120 }));
  assert.equal(f.following, true);
  assert.equal(fol.length, 0);
  f.destroy();
  player.destroy();
});
