# 接口与信令协议（v2）

服务基地址：`http://192.168.199.100:9002`

v2 不再使用房间号：每个终端连接后由服务器分配唯一 ID，所有在线终端自动出现在通讯录中，点选即可呼叫，支持多人。

## 一、HTTP 接口

### 公共

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 客户端配置：ICE 服务器、单次通话人数上限、公告 |

### 管理（需 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | 登录，返回 `token` |
| GET | `/api/admin/overview` | 在线终端数、通话数、累计通话、运行时长 |
| GET | `/api/admin/terminals` | 在线终端列表（状态、IP、媒体统计） |
| GET | `/api/admin/calls` | 进行中的通话与成员 |
| GET | `/api/admin/metrics` | 采样趋势与历史通话 |
| GET | `/api/admin/logs?limit=100&level=info` | 服务日志 |
| POST | `/api/admin/terminals/{id}/kick` | 将终端下线 |
| POST | `/api/admin/settings` | 更新公告、`maxCallMembers` |

## 二、WebSocket 信令

地址：`ws://192.168.199.100:9002/ws`，JSON 文本帧。

### 客户端 → 服务端

| type | 字段 | 说明 |
| --- | --- | --- |
| `register` | `name`, `deviceId?`, `device{platform,model,brand,os,appVersion,isTv}` | 登录并注册终端；`deviceId` 可复用上次 ID |
| `call-invite` | `targets:[id...]`, `video` | 呼叫一个或多个终端 |
| `call-accept` | `callId` | 接听 |
| `call-reject` | `callId` | 拒接 |
| `call-cancel` | `callId` | 取消呼叫 |
| `call-leave` | `callId` | 挂断/离开 |
| `offer` / `answer` | `to`, `callId`, `sdp` | SDP 转发 |
| `ice` | `to`, `callId`, `candidate{...}` | ICE 候选 |
| `state` | `muted{audio,video}` | 静音状态同步 |
| `stats` | `rtt`, `bitrate`, `width`, `height`, `fps` | 媒体统计上报 |
| `ping` | `t` | 心跳 |

### 服务端 → 客户端

| type | 字段 | 说明 |
| --- | --- | --- |
| `welcome` | `id`, `iceServers`, `maxCallMembers`, `ringTimeoutSeconds` | 连接建立 |
| `registered` | `self{id,name,...}` | 注册成功，返回终端 ID |
| `directory` | `self`, `terminals[]` | 在线通讯录（不含自己） |
| `call-created` | `callId`, `members[]`, `invited[]`, `maxMembers` | 呼叫已创建 |
| `call-incoming` | `callId`, `from`, `video`, `group`, `members[]` | 收到来电 |
| `call-joined` | `callId`, `members[]` | 已加入通话，需向 members 发起 offer |
| `call-member-joined` | `callId`, `member` | 有新成员加入 |
| `call-member-left` | `callId`, `id`, `name` | 成员离开 |
| `call-rejected` | `callId`, `id`, `name` | 对方拒接 |
| `call-cancelled` | `callId`, `reason` | 呼叫取消/邀请超时 |
| `call-timeout` | `callId`, `id`, `name` | 某终端无应答 |
| `call-ended` | `callId`, `reason` | 通话结束 |
| `call-failed` | `target`, `reason` | 部分被叫不可用 |
| `offer` / `answer` / `ice` | `from`, `callId`, ... | 媒体信令 |
| `member-state` | `id`, `muted` | 成员静音状态 |
| `kicked` | `reason` | 被管理员下线 |
| `error` | `code`, `message` | 错误 |

### 错误码

| code | 含义 |
| --- | --- |
| `not_registered` | 未注册就呼叫 |
| `busy` | 自己已在通话中 |
| `no_target` | 未选择呼叫对象 |
| `too_many` | 超过单次通话人数上限 |
| `no_available` | 对方正忙或离线 |
| `call_not_found` | 通话已结束 |
| `not_invited` | 邀请已失效 |
| `peer_not_found` | 对端已离开 |
| `not_in_call` | 不在通话中 |
| `unknown_type` | 未知消息类型 |

## 三、呼叫流程

### 一对一

```
A                       服务端                       B
│ register              │                          │
│◄── directory ─────────│                          │
│ call-invite(targets=[B]) ──────►│               │
│◄── call-created ──────│──── call-incoming ──────►│
│                       │◄─── call-accept ─────────│
│◄── member-joined ─────│──── call-joined ────────►│
│                       │   （B 向 A 发 offer）      │
│◄──── offer ───────────┼──── offer ──────────────►│
│──── answer ──────────►│◄─── answer ──────────────│
│◄══════ P2P 音视频（WebRTC）══════════════════════►│
```

### 多人（Mesh）

邀请方选择多个在线终端；每人接听后，**新加入者**向所有已有成员各发起一条 `offer`，形成全连接 Mesh（默认上限 6 人，可配置 2-12）。

```
C 邀请 D、E：
C ── call-invite([D,E]) ──► 服务端
D/E 接听 → C 收到 member-joined
D 接听后：D → C 发 offer
E 接听后：E → C、E → D 各发 offer
```

## 四、状态与保活

- 终端状态：`idle`（空闲）/`ringing`（响铃）/`busy`（通话中）
- 来电 45 秒无应答自动取消
- 服务端每 10 秒 ping，90 秒无响应断开；断开即从通讯录移除
- 通话中最后一人离开或仅剩一人时通话结束
