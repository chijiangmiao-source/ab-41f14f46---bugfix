# 星载图像处理器 · 跨队列缓冲区同步/所有权移交复核台

解码、校正、编码提交分派到不同硬件队列时，审查员需要复核：**同一缓冲区区间是否在同步与所有权移交证据不足的情况下被另一队列读取**。

本服务提供操作页与复核引擎，依据**队列顺序**与**时间线信号量等待**建立偏序，并逐单元维护
`owner`（属主队列）、`version`（最新写版本）、`pending`（待获取移交）与最近一次完整移交证据。

## 录入上限

- 至多 **3** 条队列
- 至多 **16** 个缓冲区，每个长度不超过 **64** 个单元
- 至多 **48** 个提交
- 每个提交可 `wait`（等待时间线值）/ `signal`（完成后递增时间线，可填写显式目标值），操作按顺序包含区间 `read` / `write` / `release` / `acquire`

## 时间线目标值语义

- **留空（既有行为）**：按录入顺序把时间线递增为 1,2,3…；`wait t>=v` 由第 v 次 `signal` 满足。
- **显式目标值**：允许跳跃（声明到 5 的信号可满足 `wait>=4`，取所有 ≥ 等待值的声明中最小者作为满足来源），也允许**乱序录入**——同一时间线上的显式值构成唯一的严格递增链，例如先录入声明 5、后录入声明 3 时，仍强制声明 3 的提交先于声明 5 的提交执行。
- 同一时间线的重复目标值（含与隐式递增计数撞值）无法形成严格递增的执行先后，按 `SIGNAL_VALUE_CONFLICT` 拒绝，不会被伪装成有效同步。

## 复核规则

1. 偏序边：同队列提交按录入顺序先后；同一时间线显式目标值按值严格递增先后；`wait timeline>=v` 边向声明值 ≥v 的最小信号提交（可跨队列、可跳跃）。
2. 拒绝：
   - `UNSATISFIED_WAIT`：等待无满足来源（时间线从未递增到该值）；
   - `SIGNAL_VALUE_CONFLICT`：同一时间线的目标值重复，无法形成严格递增先后；
   - `DEADLOCK_CYCLE`：偏序成环，报告环上提交与各自单元范围；
   - `NO_OWNER` / `WRONG_OWNER`：读从未写入的单元、非属主写或释放；
   - `MISSING_RELEASE`：跨队列读/获取缺少释放；
   - `ORDERING_MISSING`：释放提交与读取提交之间缺少信号量/队列先后（首个无序读写）；
   - `MISSING_ACQUIRE`：**缺少获取的跨队列读取**；
   - `STALE_VERSION`：读取/获取过期版本。
3. 跨队列读只有在 **释放 + 信号量先后关系 + 获取** 三类证据完整匹配时才可见。
4. 通过时返回：可执行次序（拓扑序）、每个提交受影响区间（读/写/释放/获取，含版本与移交证据）、完整移交记录。

复核在浏览器 **Web Worker**（`src/verifier/worker.js`）中执行，HTTP `POST /api/verify` 提供同构实现用于冒烟。

## 本地运行

```bash
npm ci
npm start                 # http://localhost:3000/
```

- 操作页：`GET /`
- 健康响应：`GET /health`
- 标准场景：`GET /api/scenarios`
- 复核：`POST /api/verify`

## Compose

```bash
docker compose up --build web        # 启动操作页（:3000，含健康检查）
docker compose run --rm verify       # 一次性验收服务，以退出码报告结果
# 或： docker compose up --build verify （等待 web 健康后执行并退出）
```

`verify` 服务依次执行：

1. 规则代码测试（`node --test`，含 Worker 协议、两类读取场景、乱序目标值/跳跃门槛/重复目标值、死锁环、错误属主、过期版本等）；
2. 操作页构建检查（结构与内联脚本可编译、Worker 接线）；
3. API/HTTP 冒烟：
   - “缺少获取的跨队列读取” → HTTP 422 / `MISSING_ACQUIRE`，定位提交与单元范围；
   - “完整移交后读取” → HTTP 200，呈现可执行次序、版本 v1 与移交证据（releaseBy/acquireBy/via=semaphore）；
   - “乱序目标值（5 先录、3 后录、等待 ≥4）” → HTTP 200，可执行次序 校正→解码→编码，读取证据含释放、`frame-ready` 等待（声明 5 满足等待 4）与获取；
   - “跳跃门槛” → 声明 5 满足等待 4；“重复目标值” → HTTP 422 / `SIGNAL_VALUE_CONFLICT`。

退出码 `0` 表示验收通过，非 `0` 表示失败。

## 目录

```
src/verifier/limits.js    录入上限
src/verifier/validator.js 结构校验
src/verifier/engine.js    偏序 DAG + 逐单元状态机（Node / Worker UMD）
src/verifier/worker.js    Web Worker 入口
src/scenarios.js          标准场景（缺少获取 / 完整移交 / 死锁 / 乱序目标值 / 跳跃门槛 / 重复目标值）
src/public/index.html     操作页
src/server.js             HTTP 服务
test/                     node:test 规则测试
scripts/check-page.js     页面构建检查
scripts/smoke-http.js     HTTP 冒烟
scripts/verify.js         一次性验收入口
```
