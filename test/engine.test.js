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

test('乱序录入的目标值：声明 5 先录、声明 3 后录，等待 ≥4 得到 校正→解码→编码 的次序与完整移交证据', () => {
  const r = analyze(scenarios.outOfOrderTargets.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['C1', 'D1', 'E1']);

  // 目标值 3 的提交必须先于目标值 5 的提交（即使录入顺序相反）
  assert.equal(r.timelines['frame-ready'].signaled, 5);
  assert.deepEqual(r.timelines['frame-ready'].declaredValues, [5, 3]);

  const e1 = r.affectedRanges.E1;
  const read = e1.reads[0];
  assert.equal(read.buffer, 'frame');
  assert.deepEqual([read.start, read.end], [0, 8]);
  assert.equal(read.version, 1);
  assert.ok(read.evidence, '编码读取必须携带完整移交证据');
  assert.equal(read.evidence.releaseBy, 'D1');
  assert.equal(read.evidence.acquireBy, 'E1');
  assert.equal(read.evidence.fromQueue, 'decode-q');
  assert.equal(read.evidence.toQueue, 'encode-q');
  assert.equal(read.evidence.via.kind, 'semaphore');
  assert.equal(read.evidence.via.semaphore, 'frame-ready');
  assert.equal(read.evidence.via.signalValue, 5); // 跳跃门槛：由声明到 5 的解码提交满足
  assert.equal(read.evidence.via.waitValue, 4);

  const acquire = e1.acquires[0];
  assert.deepEqual([acquire.start, acquire.end], [0, 8]);
  assert.equal(acquire.evidence.releaseBy, 'D1');

  assert.equal(r.transfers.length, 1);
  const t = r.transfers[0];
  assert.deepEqual([t.start, t.end], [0, 8]);
  assert.equal(t.evidence.releaseBy, 'D1');
  assert.equal(t.evidence.acquireBy, 'E1');
  assert.equal(t.evidence.via.kind, 'semaphore');
});

test('目标值可跳跃：只声明到 5 的信号也满足恰好等待 4 的提交', () => {
  const r = analyze(scenarios.jumpThreshold.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['D1', 'E1']);
  const read = r.affectedRanges.E1.reads[0];
  assert.equal(read.evidence.via.signalValue, 5);
  assert.equal(read.evidence.via.waitValue, 4);
});

test('声明值全部低于等待门槛 -> UNSATISFIED_WAIT（跳跃也不能凭空满足）', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 't', value: 3 },
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }]
    },
    {
      id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 4 },
      operations: [{ type: 'read', buffer: 'f', offset: 0, length: 2 }]
    }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNSATISFIED_WAIT');
  assert.equal(r.available, 3);
  assert.equal(r.waitValue, 4);
});

test('同一时间线重复声明相同目标值 -> SIGNAL_VALUE_CONFLICT（不得伪装成有效同步）', () => {
  const r = analyze(scenarios.duplicateTarget.input);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNAL_VALUE_CONFLICT');
  assert.equal(r.semaphore, 'frame-ready');
  assert.equal(r.signalValue, 5);
  assert.deepEqual(new Set(r.submissionIds), new Set(['D1', 'C1']));
});

test('显式目标值与隐式递增计数撞值 -> SIGNAL_VALUE_CONFLICT', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't', value: 1 }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] },
    { id: 'B', queue: 'Q1', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 2, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNAL_VALUE_CONFLICT');
  assert.equal(r.signalValue, 1);
});

test('未填目标值的既有递增录入仍按第 v 次 signal 满足等待（原行为回归）', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 't' },
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }, { type: 'release', buffer: 'f', offset: 0, length: 2 }]
    },
    {
      id: 'B', queue: 'Q0', signal: { semaphore: 't' },
      operations: [{ type: 'write', buffer: 'f', offset: 2, length: 2 }, { type: 'release', buffer: 'f', offset: 2, length: 2 }]
    },
    {
      id: 'C', queue: 'Q1', wait: { semaphore: 't', value: 2 },
      operations: [
        { type: 'acquire', buffer: 'f', offset: 0, length: 4 },
        { type: 'read', buffer: 'f', offset: 0, length: 4 }
      ]
    }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['A', 'B', 'C']);
  // 等待第 2 次 signal 由 B 满足，并经队列序传递使 A 也先于 C，两段均可见
  const span = r.affectedRanges.C.reads.map((x) => [x.start, x.end]);
  assert.deepEqual(span, [[0, 2], [2, 4]]);
  assert.ok(r.affectedRanges.C.reads.every((x) => x.evidence));
});

test('目标值链与等待冲突形成环 -> DEADLOCK_CYCLE（新边同样参与死锁定位）', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', wait: { semaphore: 't', value: 2 }, signal: { semaphore: 't', value: 3 },
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }]
    },
    {
      id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 3 }, signal: { semaphore: 't', value: 2 },
      operations: [{ type: 'write', buffer: 'f', offset: 2, length: 2 }]
    }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEADLOCK_CYCLE');
  assert.deepEqual(new Set(r.cycle), new Set(['A', 'B']));
  // 环上必须包含目标值先后边与信号量等待边
  const kinds = r.edges.map((e) => e.reason && e.reason.kind);
  assert.ok(kinds.includes('timeline-target'), `环边类型: ${kinds.join(',')}`);
  assert.ok(kinds.includes('semaphore'), `环边类型: ${kinds.join(',')}`);
});

test('多个乱序显式目标值按值严格排序（录入 5,3,4 → 3→4→5）', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't', value: 5 }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] },
    { id: 'B', queue: 'Q1', signal: { semaphore: 't', value: 3 }, operations: [{ type: 'write', buffer: 'f', offset: 2, length: 2 }] },
    { id: 'C', queue: 'Q2', signal: { semaphore: 't', value: 4 }, operations: [{ type: 'write', buffer: 'f', offset: 4, length: 2 }] }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['B', 'C', 'A']);
});
