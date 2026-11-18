import test from 'node:test';
import assert from 'node:assert/strict';
import { describeForecastTracking } from './forecast-tracking.mjs';

const end = '2026-11-26T05:00:00Z';
const now = Date.parse('2026-11-18T01:00:00Z');
const gold = {
  id: 'gold-3500-before-thanksgiving', asset: 'GOLD', market: 'xyz:GOLD', kind: 'price',
  label: '感恩節前3,500', claim: '感恩節前可能到3,500，但不太可能。', confidence: '可能但不太可能',
  source: { recordedDate: '2026-11-10', videoTitle: 'Rally', timestamp: '10:24-10:34', claimIds: ['R34'] },
  window: { start: '2026-11-11T00:00:00Z', end, timeZone: 'America/New_York', label: '感恩節前', precision: 'explicit_deadline' },
  targetUsd: 3500, comparator: 'lte', sourceInstrument: 'COMEX GC futures', dailyPriority: 1, direction: 'down',
};
const btc = {
  id: 'btc-early-dec-low', asset: 'BTC', market: 'BTC', kind: 'turn', label: '弱至12月初候選低點',
  claim: '偏弱或橫盤到12月初，再反彈。', confidence: '候選',
  source: { recordedDate: '2026-11-03', timestamp: '05:14', claimIds: ['B21'] },
  window: { start: '2026-11-25T05:00:00Z', end: '2026-12-11T05:00:00Z', timeZone: 'America/New_York', label: '12月初追蹤粗窗口', precision: 'coarse_window' },
  sourceInstrument: 'BTC unspecified market', dailyPriority: 2, direction: null,
};
const registry = { schemaVersion: 1, registryAsOf: '2026-11-18', nodes: [gold, btc] };
const feedAt = (date = '2026-11-17T08:58:02.495Z', price = 3872.15) => ({
  a: { name: 'A', updatedAt: date, levels: { BTC: { midUsd: 64287.5 }, 'xyz:GOLD': { midUsd: price } } },
  b: { name: 'B', updatedAt: date, levels: { BTC: { midUsd: 64287.5 }, 'xyz:GOLD': { midUsd: price } } },
});
const run = options => describeForecastTracking({ registry, feed: feedAt(), now, ...options });

test('3,872.15 to 3,500 requires another 9.6% decline, not a subjective near-target label', () => {
  const result = run();
  const node = result.nodes[0];
  assert.ok(Math.abs(node.requiredMovePct + 9.610939658845863) < 1e-9);
  assert.ok(Math.abs(node.gapUsd - 372.15) < 1e-9);
  assert.match(result.report, /9\.6%/);
  assert.match(result.report, /不太可能/);
  assert.match(result.report, /舊快照/);
  assert.match(result.report, /2026\/11\/17/);
  assert.equal(node.preciseOutcome, 'unverified');
});

test('explicit deadline is exclusive and an absent intraday history is not a miss', () => {
  const before = run({ now: Date.parse(end) - 1 });
  const ended = run({ now: Date.parse(end) });
  assert.equal(before.nodes[0].temporalStatus, 'in_window');
  assert.equal(ended.nodes[0].temporalStatus, 'window_ended');
  assert.equal(ended.nodes[0].preciseOutcome, 'unverified');
  assert.match(ended.report, /窗口結束，原市場是否觸價待核對/);
  assert.doesNotMatch(ended.report, /已失準|目標失敗|確定未達/);
});

test('Hyperliquid reference threshold is never a verified COMEX forecast hit', () => {
  const result = run({ feed: feedAt('2026-11-18T00:30:00Z', 3490) });
  const node = result.nodes[0];
  assert.equal(node.referenceWithinThreshold, true);
  assert.equal(node.referenceTouchObserved, true);
  assert.equal(node.sourceMarketComparable, false);
  assert.equal(node.preciseOutcome, 'unverified');
  assert.match(result.report, /不等於原市場目標已命中/);
});

test('missing prices, invalid times and future snapshots do not imply unchanged or failed target', () => {
  for (const feed of [{}, feedAt('2026-11-19T00:00:00Z'), feedAt('2026-11-18'), feedAt('not-a-date'), feedAt('2026-11-18T00:30:00Z', 0)]) {
    const result = run({ feed });
    assert.equal(result.nodes[0].referencePriceUsd, null);
    assert.equal(result.nodes[0].requiredMovePct, null);
    assert.equal(result.nodes[0].status, '資料不足');
    assert.match(result.report, /資料不足|缺失/);
  }
});

test('conflicting prices across valid snapshots are not resolved by choosing a trader', () => {
  const feed = feedAt();
  feed.b.levels['xyz:GOLD'].midUsd = 3800;
  const result = run({ feed });
  assert.equal(result.nodes[0].referenceStatus, 'conflict');
  assert.equal(result.nodes[0].referencePriceUsd, null);
  assert.match(result.report, /不一致/);
});

test('earliest supporting timestamp is kept for equal quotes and input is unchanged', () => {
  const feed = feedAt();
  feed.b.updatedAt = '2026-11-17T08:59:00Z';
  const copy = structuredClone({ feed, registry });
  const result = run({ feed });
  assert.equal(result.priceAsOf.GOLD, '2026-11-17T08:58:02.495Z');
  assert.deepEqual({ feed, registry }, copy);
});

test('same snapshot is not counted again; a prior reference touch survives a later higher price', () => {
  const first = run({ feed: feedAt('2026-11-18T00:00:00Z', 3490) });
  const repeated = run({ feed: feedAt('2026-11-18T00:00:00Z', 3490), previous: first });
  assert.equal(repeated.nodes[0].referenceObservationCount, 1);
  assert.equal(repeated.nodes[0].observationUpdate, 'same_snapshot');
  const copy = structuredClone(first);
  const later = run({ feed: feedAt('2026-11-18T00:30:00Z', 3850), previous: first });
  assert.equal(later.nodes[0].referenceTouchObserved, true);
  assert.equal(later.nodes[0].referenceObservationCount, 2);
  assert.equal(later.nodes[0].firstReferenceTouch.priceUsd, 3490);
  assert.deepEqual(first, copy);
  assert.deepEqual(later.nodes[0].source, gold.source);
  assert.equal(later.nodes[0].preciseOutcome, 'unverified');
});

test('missing or older new snapshots retain only valid historical state, not invented current quotes', () => {
  const first = run({ feed: feedAt('2026-11-18T00:30:00Z', 3490) });
  const missing = run({ feed: {}, previous: first });
  assert.equal(missing.nodes[0].referencePriceUsd, null);
  assert.equal(missing.nodes[0].referenceTouchObserved, true);
  assert.equal(missing.nodes[0].referenceObservationCount, 1);
  const older = run({ feed: feedAt('2026-11-18T00:00:00Z', 3400), previous: first });
  assert.equal(older.nodes[0].referenceObservationCount, 1);
  assert.equal(older.nodes[0].observationUpdate, 'older_snapshot_ignored');
});

test('changing the source definition does not silently reuse an old hit or mutate the deadline', () => {
  const first = run({ feed: feedAt('2026-11-18T00:00:00Z', 3490) });
  const changed = structuredClone(registry);
  changed.nodes[0].window.end = '2027-01-01T05:00:00Z';
  const result = run({ registry: changed, previous: first });
  assert.equal(result.nodes[0].referenceTouchObserved, false);
  assert.equal(registry.nodes[0].window.end, end);
  assert.equal(result.nodes[0].source.recordedDate, gold.source.recordedDate);
});

test('a touch at or after the deadline cannot be backfilled into the original window', () => {
  const result = run({ now: Date.parse(end) + 1000, feed: feedAt(end, 3400) });
  assert.equal(result.nodes[0].referenceTouchObserved, false);
  assert.equal(result.nodes[0].referenceObservationCount, 0);
  assert.equal(result.nodes[0].temporalStatus, 'window_ended');
});

test('an unverified unmet condition cannot activate a late alternative or extend the original target', () => {
  const later = structuredClone(gold);
  later.id = 'gold-late';
  later.dependsOn = { id: gold.id, condition: 'not_reached' };
  later.window = { ...later.window, start: '2027-10-01T04:00:00Z', end: '2028-01-01T05:00:00Z', openEnded: true, precision: 'coarse_window' };
  const result = run({ registry: { ...registry, nodes: [gold, later] }, now: Date.parse('2028-01-02T01:00:00Z'), feed: feedAt('2028-01-02T00:00:00Z') });
  assert.equal(result.nodes[0].window.end, end);
  assert.equal(result.nodes[1].conditionStatus, 'unverified');
  assert.equal(result.nodes[1].status, '條件未核對');
  assert.equal(result.nodes[1].temporalStatus, 'after_coarse_window_open_end');
  assert.match(result.nodes[1].reason, /無|沒有硬性截止/);
  assert.equal(result.nodes[1].preciseOutcome, 'unverified');
});

test('coarse windows are labelled, not scored as correct or incorrect', () => {
  const result = run({ now: Date.parse('2026-12-12T01:00:00Z') });
  const node = result.nodes.find(n => n.asset === 'BTC');
  assert.equal(node.temporalStatus, 'window_ended');
  assert.equal(node.preciseOutcome, 'unverified');
  assert.match(result.report, /粗窗口/);
});

test('open-ended late alternative retains post-segment reference observations without activating its condition', () => {
  const later = structuredClone(gold);
  later.id = 'gold-late';
  later.dependsOn = { id: gold.id, condition: 'not_reached' };
  later.window = { ...later.window, start: '2027-10-01T04:00:00Z', end: '2028-01-01T05:00:00Z', openEnded: true, precision: 'coarse_window' };
  const options = { registry: { ...registry, nodes: [gold, later] }, now: Date.parse('2028-01-02T01:00:00Z'), feed: feedAt('2028-01-02T00:00:00Z', 3400) };
  const first = run(options);
  assert.equal(first.nodes[0].referenceTouchObserved, false);
  assert.equal(first.nodes[1].referenceTouchObserved, true);
  assert.equal(first.nodes[1].referenceObservationCount, 1);
  assert.equal(first.nodes[1].status, '條件未核對');
  assert.equal(first.nodes[1].preciseOutcome, 'unverified');
  const next = run({ ...options, now: Date.parse('2028-01-03T01:00:00Z'), feed: feedAt('2028-01-03T00:00:00Z', 3800), previous: first });
  assert.equal(next.nodes[1].referenceTouchObserved, true);
  assert.equal(next.nodes[1].referenceObservationCount, 2);
  assert.equal(next.nodes[1].firstReferenceTouch.priceUsd, 3400);
  assert.equal(next.nodes[1].status, '條件未核對');
});

test('an open-ended conditional target remains visible beyond the tracking segment', () => {
  const later = structuredClone(gold);
  later.id = 'gold-late-open';
  later.label = '後期條件目標3,500';
  later.dependsOn = { id: gold.id, condition: 'not_reached' };
  later.window = { ...later.window, start: '2027-10-01T04:00:00Z', end: '2028-01-01T05:00:00Z', openEnded: true, precision: 'coarse_window' };
  const result = run({ registry: { ...registry, nodes: [gold, later] },
    now: Date.parse('2028-02-01T01:00:00Z'), feed: feedAt('2028-02-01T00:00:00Z', 3400) });
  assert.equal(result.nodes[1].temporalStatus, 'after_coarse_window_open_end');
  assert.equal(result.nodes[1].conditionStatus, 'unverified');
  assert.match(result.report, /前一條件未核對/);
});

test('malformed window is retained as insufficient instead of crashing the main daily report', () => {
  const invalid = structuredClone(registry);
  invalid.nodes[0].window.end = 'bad';
  const result = run({ registry: invalid });
  assert.equal(result.nodes[0].status, '資料不足');
  assert.equal(result.nodes[0].referenceTouchObserved, false);
});

test('all report budgets are respected without truncating the weak-confidence price claim', () => {
  for (const maxReportChars of [0, 1, 9, 16, 30, 50, 90, 150, 240, 350, 700, 900]) {
    const result = run({ maxReportChars });
    assert.ok(result.report.length <= maxReportChars, maxReportChars);
    if (/3,500/.test(result.report)) assert.match(result.report, /不太可能|低信心/);
  }
  assert.equal(run({ maxReportChars: 0 }).report, '');
  assert.match(run().report, /ETH.*沒有獨立/);
});

test('persisted state stays bounded instead of nesting previous reports', () => {
  let previous;
  for (let i = 0; i < 20; i++) previous = run({ previous });
  assert.equal(previous.nodes[0].referenceObservationCount, 1);
  assert.equal('previous' in previous.nodes[0], false);
  assert.ok(JSON.stringify(previous).length < 13000);
});
