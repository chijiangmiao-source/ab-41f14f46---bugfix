'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/verifier/engine');
const scenarios = require('../src/scenarios');

const base = (submissions, extra = {}) => ({
  queues: ['Q0', 'Q1', 'Q2'],
  buffers: [{ name: 'f', length: 16 }],
  submissions,
  ...extra
});

test('缺少获取的跨队列读取 -> MISSING_ACQUIRE（422 类拒绝）', () => {
  const r = analyze(scenarios.missingAcquire.input);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_ACQUIRE');
  assert.equal(r.submissionId, 'E1');
  assert.equal(r.buffer, 'frameA');
  assert.equal(r.currentOwner, 'decode-q');
});

test('完整移交（释放+信号量+获取）后读取 -> 通过，呈现版本与移交证据', () => {
  const r = analyze(scenarios.completeTransfer.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['D1', 'E1']);

  const e1 = r.affectedRanges.E1;
  const read = e1.reads[0];
  assert.equal(read.buffer, 'frameA');
  assert.deepEqual([read.start, read.end], [0, 8]);
  assert.equal(read.version, 1);
  assert.ok(read.evidence, '跨队列取得的读必须携带移交证据');
  assert.equal(read.evidence.fromQueue, 'decode-q');
  assert.equal(read.evidence.toQueue, 'encode-q');
  assert.equal(read.evidence.releaseBy, 'D1');
  assert.equal(read.evidence.acquireBy, 'E1');
  assert.equal(read.evidence.via.kind, 'semaphore');

  assert.equal(r.transfers.length, 1);
  assert.deepEqual([r.transfers[0].start, r.transfers[0].end], [0, 8]);
});

test('同队列顺序读：后者可见前者的写，无需移交', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', operations: [{ type: 'write', buffer: 'f', offset: 0, length: 4 }] },
    { id: 'B', queue: 'Q0', operations: [{ type: 'read', buffer: 'f', offset: 0, length: 4 }] }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['A', 'B']);
  assert.equal(r.affectedRanges.B.reads[0].version, 1);
});

test('等待无满足来源 -> UNSATISFIED_WAIT', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q1', wait: { semaphore: 't', value: 2 }, operations: [{ type: 'read', buffer: 'f', offset: 0, length: 1 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNSATISFIED_WAIT');
  assert.equal(r.available, 0);
});

test('信号量等待成环 -> DEADLOCK_CYCLE，环中提交与区间被定位', () => {
  const r = analyze(scenarios.deadlock.input);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEADLOCK_CYCLE');
  assert.deepEqual(new Set(r.cycle), new Set(['D1', 'D2']));
  assert.ok(r.touchedRanges.D1.some((x) => x.buffer === 'frameA'));
});

test('跨队列无释放的读取 -> MISSING_RELEASE', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] },
    { id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'read', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_RELEASE');
  assert.equal(r.submissionId, 'B');
});

test('非属主写入 -> WRONG_OWNER', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] },
    { id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_OWNER');
  assert.equal(r.currentOwner, 'Q0');
});

test('过期版本获取：释放后属主又写新版本 -> STALE_VERSION', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 't' },
      operations: [
        { type: 'write', buffer: 'f', offset: 0, length: 2 },
        { type: 'release', buffer: 'f', offset: 0, length: 2 },
        { type: 'write', buffer: 'f', offset: 0, length: 2 }
      ]
    },
    { id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'acquire', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STALE_VERSION');
  assert.equal(r.observedVersion, 1);
  assert.equal(r.expectedVersion, 2);
});

test('信号量传递先后（Q0→Q1→Q2）支撑跨队列完整移交链', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 'a' },
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }, { type: 'release', buffer: 'f', offset: 0, length: 2 }]
    },
    {
      id: 'B', queue: 'Q1', wait: { semaphore: 'a', value: 1 }, signal: { semaphore: 'b' },
      operations: [
        { type: 'acquire', buffer: 'f', offset: 0, length: 2 },
        { type: 'read', buffer: 'f', offset: 0, length: 2 },
        { type: 'release', buffer: 'f', offset: 0, length: 2 }
      ]
    },
    {
      id: 'C', queue: 'Q2', wait: { semaphore: 'b', value: 1 },
      operations: [{ type: 'acquire', buffer: 'f', offset: 0, length: 2 }, { type: 'read', buffer: 'f', offset: 0, length: 2 }]
    }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['A', 'B', 'C']);
  assert.equal(r.affectedRanges.C.reads[0].version, 1);
});

test('等待的信号量与释放提交无先后关系 -> ORDERING_MISSING（首个无序读写）', () => {
  const r = analyze(base([
    // S1 发出被等待的信号，但只操作无关单元
    { id: 'S1', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 10, length: 1 }] },
    // S2 之后才写并释放，未与 S1 建立信号关系
    {
      id: 'S2', queue: 'Q0',
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }, { type: 'release', buffer: 'f', offset: 0, length: 2 }]
    },
    // S3 等到的是 S1 的信号，释放方 S2 并不先于 S3 -> 无序
    { id: 'S3', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'read', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ORDERING_MISSING');
  assert.equal(r.submissionId, 'S3');
  assert.equal(r.releaseBy, 'S2');
});

test('读取从未写入的单元 -> NO_OWNER', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', operations: [{ type: 'read', buffer: 'f', offset: 3, length: 1 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_OWNER');
});

test('结构校验：超上限与越界区间被拒绝', () => {
  const tooManyQueues = {
    queues: ['a', 'b', 'c', 'd'],
    buffers: [{ name: 'f', length: 4 }],
    submissions: []
  };
  assert.equal(analyze(tooManyQueues).code, 'STRUCTURE_INVALID');

  const overrun = base([
    { id: 'A', queue: 'Q0', operations: [{ type: 'write', buffer: 'f', offset: 14, length: 4 }] }
  ]);
  assert.equal(analyze(overrun).code, 'STRUCTURE_INVALID');
});

test('乱序录入的显式目标值：按值定序 校正(3)→解码(5)→编码，完整移交证据', () => {
  const r = analyze(scenarios.outOfOrderTargets.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['C1', 'D1', 'E1']);

  // 编码读取的是解码区间，且携带 解码释放 / 时间线等待 / 编码获取 的完整证据
  const read = r.affectedRanges.E1.reads[0];
  assert.equal(read.buffer, 'frame');
  assert.deepEqual([read.start, read.end], [0, 4]);
  assert.equal(read.version, 1);
  assert.ok(read.evidence, '跨队列取得的读必须携带移交证据');
  assert.equal(read.evidence.fromQueue, 'decode-q');
  assert.equal(read.evidence.toQueue, 'encode-q');
  assert.equal(read.evidence.releaseBy, 'D1');
  assert.equal(read.evidence.acquireBy, 'E1');
  assert.equal(read.evidence.via.kind, 'semaphore');
  assert.equal(read.evidence.via.semaphore, 'frame-ready');
  assert.equal(read.evidence.via.signalValue, 5); // 由声明到 5 的信号满足
  assert.equal(read.evidence.via.waitValue, 4); // 编码只等待 >=4

  // 移交记录同样完整
  assert.equal(r.transfers.length, 1);
  const t = r.transfers[0];
  assert.deepEqual([t.start, t.end], [0, 4]);
  assert.equal(t.evidence.releaseBy, 'D1');
  assert.equal(t.evidence.acquireBy, 'E1');
  assert.equal(t.evidence.via.kind, 'semaphore');

  // 校正只操作不重叠的后半段
  const c1 = r.affectedRanges.C1;
  assert.deepEqual([c1.writes[0].start, c1.writes[0].end], [4, 8]);
});

test('目标值可跳跃：声明到 5 的信号满足等待 4（无需恰好声明 4）', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 't', value: 5 },
      operations: [
        { type: 'write', buffer: 'f', offset: 0, length: 2 },
        { type: 'release', buffer: 'f', offset: 0, length: 2 }
      ]
    },
    {
      id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 4 },
      operations: [
        { type: 'acquire', buffer: 'f', offset: 0, length: 2 },
        { type: 'read', buffer: 'f', offset: 0, length: 2 }
      ]
    }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['A', 'B']);
  assert.equal(r.affectedRanges.B.reads[0].evidence.via.signalValue, 5);
  assert.equal(r.affectedRanges.B.reads[0].evidence.via.waitValue, 4);
});

test('跳跃仍须达到门槛：只声明到 3 无法满足等待 4 -> UNSATISFIED_WAIT', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't', value: 3 }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 1 }] },
    { id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 4 }, operations: [{ type: 'read', buffer: 'f', offset: 0, length: 1 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNSATISFIED_WAIT');
  assert.equal(r.available, 3);
});

test('同一时间线重复的显式目标值 -> INVALID_SIGNAL_VALUE（不伪装成有效同步）', () => {
  const r = analyze(scenarios.duplicateTarget.input);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_SIGNAL_VALUE');
  assert.equal(r.submissionId, 'C1');
  assert.equal(r.semaphore, 'frame-ready');
  assert.equal(r.signalValue, 3);
  assert.equal(r.firstDeclaredBy, 'D1');
});

test('未填目标值的既有递增录入：信号自动取值 1、2，等待 1/2 各自满足', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 't' }, // 自动取值 1
      operations: [
        { type: 'write', buffer: 'f', offset: 0, length: 2 },
        { type: 'release', buffer: 'f', offset: 0, length: 2 }
      ]
    },
    {
      id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 }, signal: { semaphore: 't' }, // 自动取值 2
      operations: [
        { type: 'acquire', buffer: 'f', offset: 0, length: 2 },
        { type: 'read', buffer: 'f', offset: 0, length: 2 },
        { type: 'release', buffer: 'f', offset: 0, length: 2 }
      ]
    },
    {
      id: 'C', queue: 'Q2', wait: { semaphore: 't', value: 2 },
      operations: [
        { type: 'acquire', buffer: 'f', offset: 0, length: 2 },
        { type: 'read', buffer: 'f', offset: 0, length: 2 }
      ]
    }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['A', 'B', 'C']);
  assert.equal(r.timelines.t.signaled, 2);
  assert.deepEqual(r.timelines.t.declaredValues, [1, 2]);
  assert.equal(r.affectedRanges.C.reads[0].evidence.via.signalValue, 2);
});

test('后录入的显式值与自动递增信号撞值 -> INVALID_SIGNAL_VALUE', () => {
  const r = analyze(base([
    // 第一个信号未填值，自动取 1
    { id: 'A', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 1 }] },
    // 后录入却显式声明 1 —— 与自动递增值重复，不得伪装成同步
    { id: 'B', queue: 'Q1', signal: { semaphore: 't', value: 1 }, operations: [{ type: 'write', buffer: 'f', offset: 1, length: 1 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_SIGNAL_VALUE');
  assert.equal(r.submissionId, 'B');
  assert.equal(r.signalValue, 1);
  assert.equal(r.firstDeclaredBy, 'A');
});

test('时间线顺序边可与等待边共同成环 -> DEADLOCK_CYCLE 仍可靠定位', () => {
  // 时间线 t 按值定序 S3(3) -> S5(5)；X 等 t>=5 后发 g，S3 等 g>=1：
  // 环 S3 ->(timeline-order 3->5) S5 ->(wait t>=5) X ->(signal g) S3
  const r = analyze(base([
    {
      id: 'S3', queue: 'Q1', wait: { semaphore: 'g', value: 1 }, signal: { semaphore: 't', value: 3 },
      operations: [{ type: 'write', buffer: 'f', offset: 2, length: 2 }]
    },
    {
      id: 'S5', queue: 'Q0', signal: { semaphore: 't', value: 5 },
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }]
    },
    {
      id: 'X', queue: 'Q2', wait: { semaphore: 't', value: 5 }, signal: { semaphore: 'g' },
      operations: [{ type: 'write', buffer: 'f', offset: 4, length: 2 }]
    }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEADLOCK_CYCLE');
  assert.ok(r.cycle.includes('S3') && r.cycle.includes('S5') && r.cycle.includes('X'));
  assert.ok(r.edges.some((e) => e.reasons.some((x) => x.kind === 'timeline-order')), '环证据中包含时间线顺序边');
});
