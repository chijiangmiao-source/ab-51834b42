# 低温阵列扫描复核台

低温阵列扫描持续产生稀疏校正帧。复核员在网络抖动或浏览器休眠后重连，仍须看到**同一代采集**的连续累计曲线：不漏帧、不重放、不混入已重开的采集。

本服务为零运行时依赖的 Node 20 全栈应用（内置 `http` / SSE / `node:test`，前端原生 ES Module + Canvas）。

## 页面

| 页面 | 地址 | 说明 |
| --- | --- | --- |
| 复核台 | `/` | 新开采集、按操作标识追加多通道增量帧，展示代号、连续序号、各通道累计值与连续累计曲线、连接状态 |
| 监看墙 | `/monitor.html` | 只读监看，断网/休眠重连后自动续接同一代曲线 |
| 健康检查 | `/health` | 容器就绪探针 |

## HTTP / 事件接口

- `POST /api/generations` — 新开一代采集。Body：`{"channels":["A","B"], "generation":"可选代号"}`。开代即清空旧帧与旧操作台账，序号从 1 重新开始。
- `POST /api/appends` — 追加一帧。Body：`{"generation","opId","increments":{"A":1.5,"B":-0.2}}`。
  - 一次持久化事务（互斥锁内分配序号 + 更新快照 + `fsync` + 原子 `rename`）。
  - 序号在代内严格递增，帧可含多个通道增量。
  - 相同 `opId` + 相同参数重试：返回**原序号**（`duplicate:true`），不再写帧、不产生事件。
  - 相同 `opId` + 不同参数：稳定 **409** 拒绝，不分配序号、不产生事件。
  - 代际不符（旧连接重放到新代）：**409**。
- `GET /api/state` — 权威快照与保留帧。
- `GET /api/stream?generation=<代号>&cursor=<序号>` — SSE：
  - 首次连接（无游标）先收到 `reset`（含高水位快照与最近帧），客户端**原子替换**画面；
  - 重连携带代号与游标：先收 `snapshot`（带高水位），再按序收缺口 `frame` 增量；
  - 游标过旧（缺口超出最近 **32** 帧）：发送 `reason:"cursor_stale"` 的完整 `reset`；
  - 请求代际非当前代：`generation_mismatch`；
  - 旧连接绑定的代被重开：`stale_generation`；旧连接**收不到**新一代任何帧（事件按绑定代际过滤）。

## 一致性要点

- **并发重复追加只落一帧**：Store 写操作经单把 Promise 锁串行化，幂等台账随事务持久化。
- **不重放**：SSE 先订阅后读状态，订阅与重放之间到达的帧按“已补发最大序号”去重。
- **旧代隔离**：服务端按连接绑定代际过滤帧事件；前端再次校验 `frame.generation`，异代迟到事件只计数、不改写画面。
- **明确状态**：序号缺口（`gap`）、代际不符/旧代失效（`stale`/`mismatch`）、不可恢复（`fatal`，事件流与 REST 均失败）均有显式横幅与连接灯。

## 本地运行

```bash
node server/server.js          # 默认 0.0.0.0:8080
PORT=9090 DATA_FILE=./data/s.json node server/server.js
```

## Docker

```bash
# 构建并启动（宿主机端口可配置）
HOST_PORT=9090 docker compose up -d --build

# 单次复核：代码测试 + 前端构建检查 + API/HTTP 冒烟，以退出码报告
docker compose run --rm verify
```

数据持久化在命名卷 `scan-data`（容器内 `/app/data/store.json`）。

## 测试与脚本

```bash
npm test                 # node --test：store/core 单元 + HTTP/SSE 集成（23 个用例）
npm run build            # 前端构建检查：全部 JS 语法、import/资源引用，产物输出 dist/public
npm run smoke            # API/HTTP 冒烟（自建临时实例）
npm run verify           # 三阶段串行，任一失败即非零退出码
```
