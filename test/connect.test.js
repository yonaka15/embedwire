import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, PlayerState } from '../src/connect.js';
import { setup, sleep } from './fake-player.js';

const listenings = (posted) => posted.filter((m) => m.event === 'listening');
const commands = (posted) => posted.filter((m) => m.event === 'command');

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
  assert.equal(events[0][0], 'ready');
  assert.ok(events[0][1].asks >= 3);
  p.destroy();
});

test('gives up after giveUpAfter and reports it', async () => {
  const { win, frame } = setup();
  const p = connect(frame, { win, askInterval: 10, giveUpAfter: 40 });
  const seen = [];
  p.on('gaveUp', (e) => seen.push(e));
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
  say({ event: 'infoDelivery', info: { currentTime: 3 } }, 'https://www.youtube.com');
  assert.ok(p.ready);
  p.destroy();
});

test('initialDelivery fills the getters; infoDelivery patches them', () => {
  const { win, frame, init, tick, say } = setup();
  const p = connect(frame, { win });
  assert.equal(p.getDuration(), undefined, 'nothing known before the player speaks');
  init();
  assert.equal(p.getDuration(), 635);
  assert.equal(p.getPlayerState(), PlayerState.CUED);
  assert.equal(p.getVolume(), 100);
  assert.equal(p.isMuted(), false);
  assert.equal(p.getPlaybackRate(), 1);
  assert.deepEqual(p.getAvailablePlaybackRates(), [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.equal(p.getVideoData().video_id, 'aqz-KE-bpKQ');
  assert.equal(p.getVideoUrl(), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.deepEqual(p.getApiInterface(), ['playVideo', 'pauseVideo', 'seekTo', 'getDuration']);
  tick(12.5, PlayerState.PLAYING);
  assert.equal(p.getCurrentTime(), 12.5);
  assert.equal(p.getPlayerState(), PlayerState.PLAYING);
  assert.equal(p.getDuration(), 635, 'a patch keeps what it does not mention');
  say({ event: 'infoDelivery', info: { muted: true, volume: 40 } });
  assert.equal(p.isMuted(), true);
  assert.equal(p.getVolume(), 40);
  assert.equal(p.getInfo().duration, 635);
  p.destroy();
});

test('change events are derived from info: stateChange, playbackRateChange, volumeChange, generic info', () => {
  const { win, frame, init, tick, say } = setup();
  const p = connect(frame, { win });
  const ev = [];
  for (const n of ['stateChange', 'playbackRateChange', 'playbackQualityChange', 'volumeChange', 'timeUpdate'])
    p.on(n, (e) => ev.push([n, e]));
  const infos = [];
  p.on('info', (e) => infos.push(e.changed));
  init(); // the starting state: `info` only, no change events
  tick(0.5, 1);
  tick(1.0, 1); // same state: no stateChange
  say({ event: 'infoDelivery', info: { playerState: 2 } });
  say({ event: 'infoDelivery', info: { playbackRate: 1.5 } });
  say({ event: 'infoDelivery', info: { muted: true } });
  say({ event: 'infoDelivery', info: { muted: true } }); // unchanged: nothing
  say({ event: 'infoDelivery', info: { playbackQuality: 'hd720' } });
  const names = ev.map((e) => e[0]);
  assert.deepEqual(names, [
    'stateChange', 'timeUpdate', // 1
    'timeUpdate', // 1.0, same state
    'stateChange', // 2
    'playbackRateChange',
    'volumeChange',
    'playbackQualityChange',
  ]);
  assert.deepEqual(ev[0][1], { state: 1 });
  assert.deepEqual(ev[3][1], { state: 2 });
  assert.deepEqual(ev[4][1], { playbackRate: 1.5 });
  assert.deepEqual(ev[5][1], { volume: 100, muted: true });
  assert.deepEqual(ev[6][1], { playbackQuality: 'hd720' });
  assert.deepEqual(infos[1], ['currentTime', 'playerState']);
  assert.equal(infos.length, 7, 'an unchanged patch emits no info');
  p.destroy();
});

test("the embed's own on* events pass through: onError → error", () => {
  const { win, frame, say } = setup();
  const p = connect(frame, { win });
  const ev = [];
  p.on('error', (e) => ev.push(e));
  p.on('apiChange', (e) => ev.push(['api', e]));
  say({ event: 'onReady', info: null });
  say({ event: 'onError', info: 150 });
  say({ event: 'onApiChange', info: null });
  assert.deepEqual(ev, [{ data: 150 }, ['api', { data: null }]]);
  p.destroy();
});

test('a reloaded frame is a NEW player: handshake restarts, info is forgotten, ready stays true', async () => {
  const { win, frame, posted, init, tick, reload } = setup();
  const p = connect(frame, { win, askInterval: 15 });
  init();
  tick(1);
  assert.equal(p.getDuration(), 635);
  const before = listenings(posted).length;
  const loads = [];
  p.on('load', (e) => loads.push(e));
  reload();
  await sleep(50);
  assert.ok(listenings(posted).length >= before + 2, 'asks again after load');
  assert.equal(p.ready, true, 'ready is not withdrawn');
  assert.equal(p.getDuration(), undefined, 'the old player info is gone');
  assert.deepEqual(loads.map((l) => l.n), [1]);
  tick(0.2);
  const n = listenings(posted).length;
  await sleep(40);
  assert.equal(listenings(posted).length, n, 'stops once the new player answers');
  p.destroy();
});

test('stall while playing, resume on the next tick; no stall after a reload', async () => {
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
  tick(3, 2); // paused
  await sleep(50);
  assert.equal(ev.length, 2, 'no stall while paused');
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
  say({ event: 'infoDelivery', info: { playerState: 1 } });
  await sleep(40);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].gap_s, null);
  assert.equal(ev[0].had_tick, false);
  p.destroy();
});

test('commands carry the official names and the id; command() reaches anything', () => {
  const { win, frame, posted } = setup();
  const p = connect(frame, { win });
  p.seekTo(12.5);
  p.playVideo();
  p.pauseVideo();
  p.setVolume(30);
  p.loadVideoById({ videoId: 'x', startSeconds: 4 });
  p.command('setPlaybackQuality', ['hd720']);
  assert.deepEqual(commands(posted).map((c) => [c.func, c.args]), [
    ['seekTo', [12.5, true]],
    ['playVideo', []],
    ['pauseVideo', []],
    ['setVolume', [30]],
    ['loadVideoById', [{ videoId: 'x', startSeconds: 4 }]],
    ['setPlaybackQuality', ['hd720']],
  ]);
  assert.ok(commands(posted).every((c) => c.id === 'ytp'));
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
