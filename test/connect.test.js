import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/connect.js';
import { setup, sleep } from './fake-player.js';

const listenings = (posted) => posted.filter((m) => m.event === 'listening');

test('keeps asking until the player answers, then stops', async () => {
  const { win, frame, posted, tick } = setup();
  const p = connect(frame, { win, askInterval: 20 });
  assert.equal(listenings(posted).length, 1, 'one listening at once');
  await sleep(70);
  assert.ok(listenings(posted).length >= 3, 'retries while silent');
  const events = [];
  p.on('*', (n, props) => events.push([n, props]));
  tick(1.5);
  const n = listenings(posted).length;
  await sleep(60);
  assert.equal(listenings(posted).length, n, 'no more asks after an answer');
  assert.ok(p.ready);
  assert.deepEqual(events[0][0], 'ready');
  assert.ok(events[0][1].asks >= 3);
  p.destroy();
});

test('gives up after giveUpAfter and reports it', async () => {
  const { win, frame } = setup();
  const p = connect(frame, { win, askInterval: 10, giveUpAfter: 40 });
  const seen = [];
  p.on('gaveup', (e) => seen.push(e));
  await sleep(90);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].asks >= 2);
  assert.equal(p.ready, false);
  p.destroy();
});

test('ignores foreign origins, malformed data and other players', () => {
  const { win, frame, say, tick } = setup();
  const p = connect(frame, { win });
  say({ info: { currentTime: 1 } }, 'https://evil.example');
  say('not json');
  say({ id: 'other', info: { currentTime: 1 } });
  assert.equal(p.ready, false);
  tick(2);
  assert.equal(p.ready, true);
  p.destroy();
});

test('accepts www.youtube.com as well as nocookie', () => {
  const { win, frame, say } = setup();
  const p = connect(frame, { win });
  say({ info: { currentTime: 3 } }, 'https://www.youtube.com');
  assert.ok(p.ready);
  p.destroy();
});

test('time and state events', () => {
  const { win, frame, tick, say } = setup();
  const p = connect(frame, { win });
  const times = [];
  const states = [];
  p.on('time', (e) => times.push(e.t));
  p.on('state', (e) => states.push(e.state));
  say({ info: { playerState: -1 } });
  tick(0.5, 1);
  tick(1.0, 1);
  say({ info: { playerState: 2 } });
  assert.deepEqual(times, [0.5, 1.0]);
  assert.deepEqual(states, [-1, 1, 2], 'state emitted only on change');
  assert.equal(p.state, 2);
  p.destroy();
});

test('a reloaded frame is a NEW player: handshake restarts even though ready stays true', async () => {
  const { win, frame, posted, tick, reload } = setup();
  const p = connect(frame, { win, askInterval: 15 });
  tick(1);
  assert.ok(p.ready);
  const before = listenings(posted).length;
  const loads = [];
  p.on('load', (e) => loads.push(e));
  reload();
  await sleep(50);
  assert.ok(listenings(posted).length >= before + 2, 'asks again after load');
  assert.equal(p.ready, true, 'ready is not withdrawn');
  assert.deepEqual(loads.map((l) => l.n), [1]);
  tick(0.2);
  const n = listenings(posted).length;
  await sleep(40);
  assert.equal(listenings(posted).length, n, 'stops once the new player answers');
  p.destroy();
});

test('stall while playing, resume on the next tick; state reset on reload', async () => {
  const { win, frame, tick, reload } = setup();
  const p = connect(frame, { win, stallAfter: 20, stallPoll: 5 });
  const ev = [];
  p.on('stall', (e) => ev.push(['stall', e]));
  p.on('resume', (e) => ev.push(['resume', e]));
  tick(1, 1);
  await sleep(50);
  assert.equal(ev.length, 1);
  assert.equal(ev[0][0], 'stall');
  assert.equal(ev[0][1].had_tick, true);
  assert.ok(p.stalled);
  tick(2, 1);
  assert.equal(ev[1][0], 'resume');
  assert.equal(ev[1][1].had_tick, true);
  // paused: no stall
  tick(3, 2);
  await sleep(50);
  assert.equal(ev.length, 2, 'no stall while paused');
  // playing again then reload: the carried "playing" must not judge the new player
  tick(4, 1);
  reload();
  await sleep(50);
  assert.equal(ev.length, 2, 'no stall right after a reload');
  p.destroy();
});

test('"playing" with no tick ever is a stall with no gap', async () => {
  const { win, frame, say } = setup();
  const p = connect(frame, { win, stallAfter: 10, stallPoll: 5 });
  const ev = [];
  p.on('stall', (e) => ev.push(e));
  say({ info: { playerState: 1 } });
  await sleep(40);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].gap_s, null);
  assert.equal(ev[0].had_tick, false);
  p.destroy();
});

test('commands carry the id; seek/play/pause helpers', () => {
  const { win, frame, posted } = setup();
  const p = connect(frame, { win });
  p.seek(12.5);
  p.play();
  p.pause();
  const cmds = posted.filter((m) => m.event === 'command');
  assert.deepEqual(cmds.map((c) => [c.func, c.args]), [
    ['seekTo', [12.5, true]],
    ['playVideo', []],
    ['pauseVideo', []],
  ]);
  assert.ok(cmds.every((c) => c.id === 'ytp'));
  p.destroy();
});

test('destroy stops asking and listening', async () => {
  const { win, frame, posted, tick } = setup();
  const p = connect(frame, { win, askInterval: 10 });
  p.destroy();
  const n = posted.length;
  await sleep(40);
  assert.equal(posted.length, n);
  tick(1);
  assert.equal(p.ready, false);
});
