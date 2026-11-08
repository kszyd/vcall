# 接口与信令协议

服务基地址：`http://192.168.199.100:9002`

## 一、HTTP 接口

### 公共

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 `{ok, name, version, uptime, time}` |
| GET | `/api/config` | 客户端配置：ICE 服务器、房间人数上限、公告 |

### 管理（需 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | 登录，body `{username, password}`，返回 `{token, expiresIn}` |
| GET | `/api/admin/overview` | 概览：在线设备、房间、通话数、运行时长 |
| GET | `/api/admin/rooms` | 房间列表（含成员、IP、媒体统计） |
| GET | `/api/admin/devices` | 在线设备列表 |
| GET | `/api/admin/metrics` | 最近 10 分钟采样与通话记录 |
| GET | `/api/admin/logs?limit=100&level=info` | 服务日志 |
| POST | `/api/admin/rooms/{roomId}/kick` | 踢出设备，body `{peerId}` |
| POST | `/api/admin/settings` | 更新公告 / 单房间人数，body `{announcement, maxRoomMembers}` |

登录失败限制：同一 IP 每分钟最多 6 次。

## 二、WebSocket 信令

地址：`ws://192.168.199.100:9002/ws`，所有消息为 JSON 文本帧。

### 客户端 → 服务端

| type | 字段 | 说明 |
| --- | --- | --- |
| `join` | `room`, `name`, `device{platform,model,brand,os,appVersion,isTv}` | 加入房间 |
| `offer` | `to`, `sdp` | 发起 SDP 邀请 |
| `answer` | `to`, `sdp` | 应答 SDP |
| `ice` | `to`, `candidate{sdpMid,sdpMLineIndex,candidate}` | ICE 候选 |
| `hangup` | `to?` | 挂断通知 |
| `state` | `muted{audio,video}` | 静音/关视频状态同步 |
| `stats` | `rtt`, `bitrate`, `width`, `height`, `fps` | 媒体统计上报（管理端展示） |
| `leave` | — | 离开房间 |
| `ping` | `t` | 心跳，服务端回 `pong` |

### 服务端 → 客户端

| type | 字段 | 说明 |
| --- | --- | --- |
| `welcome` | `id`, `iceServers`, `maxRoomMembers`, `defaultRoom`, `announcement`, `serverTime` | 连接建立后下发 |
| `joined` | `room`, `self{id,name}`, `peers[]`, `callStartedAt`, `maxRoomMembers` | 加入成功 |
| `peer-joined` | `peer{id,name,device,muted}` | 有新成员进入 |
| `peer-left` | `id`, `name`, `reason` | 成员离开 |
| `peer-hangup` | `id`, `name` | 对方挂断 |
| `peer-state` | `id`, `muted{audio,video}` | 对方媒体状态变化 |
| `offer` / `answer` | `from`, `sdp` | SDP 转发 |
| `ice` | `from`, `candidate` | ICE 转发 |
| `kicked` | `reason` | 被管理员移出 |
| `error` | `code`, `message` | 错误，`code` 见下 |
| `pong` | `t`, `serverTime` | 心跳应答 |

### 错误码

| code | 含义 |
| --- | --- |
| `bad_json` | 消息不是合法 JSON |
| `bad_room` | 房间号不合法（仅 `[0-9A-Za-z_-]{1,32}`） |
| `room_full` | 房间人数已达上限 |
| `server_busy` | 房间总数达到上限 |
| `not_in_room` | 未加入房间就发送媒体信令 |
| `peer_not_found` | 对端已离线 |
| `unknown_type` | 未知消息类型 |

## 三、连接与保活

- 服务端每 10 秒发送 ping，客户端自动回 pong（OkHttp / 浏览器均自动处理）
- 90 秒无任何消息则断开，空房间立即回收
- 通话中任一端离开，另一端收到 `peer-left` 并回到等待状态

## 四、典型呼叫流程

```
A                        服务端                        B
│  join(room=1001)  ──────►│                          │
│◄──── joined(peers=[]) ───│                          │
│                          │◄──── join(room=1001) ────│
│◄──── peer-joined ────────│                          │
│                          │──── joined(peers=[A]) ──►│
│                          │◄──── offer(to=A) ────────│  (后加入者发起)
│◄──── offer(from=B) ──────│                          │
│  answer(to=B) ──────────►│──── answer(from=A) ─────►│
│◄────── ICE 双向转发 ─────┼────── ICE 双向转发 ─────►│
│◄════════════ P2P 音视频（WebRTC）══════════════════►│
```
