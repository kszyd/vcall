# VCall · 内网视频通话（Android 6+ 手机 / 电视）

前后端分离的内网视频通话方案：**Node.js 信令服务 + Web 管理后台** 用 Docker 部署，**Android APK** 覆盖手机与电视（minSdk 23）。默认服务地址 `http://192.168.199.100:9002`。

```
┌─────────────────────┐        WebSocket 信令         ┌──────────────────────┐
│  Android 手机 / 电视 │ ◄──────────────────────────► │  VCall 信令服务        │
│  (WebRTC + OkHttp)  │                              │  Node.js · :9002      │
└─────────┬───────────┘                              │  ├─ /ws   信令         │
          │            P2P 音视频（内网直连）           │  ├─ /admin 管理后台    │
          └──────────────────────────────────────────►│  └─ /call  网页通话    │
                                                      └──────────────────────┘
```

## 功能

- 房间号配对通话，1 对 1，加入即呼叫；手机与电视可互通
- 视频 / 麦克风开关、前后摄像头切换、扬声器/听筒切换、通话计时
- 服务端实时显示在线设备数、活跃房间、通话时长、分辨率/帧率/码率/延迟
- Web 管理后台：登录鉴权、房间与设备列表、强制断开、通话记录、日志、公告、单房间人数上限
- 同源网页通话页 `/call`，电脑或电视浏览器可直接加入，便于排障
- 心跳保活、断线提示、房间自动回收
- 零第三方依赖的服务端（无 npm install 步骤），镜像约 60 MB

## 目录结构

```
vcall/
├─ server/                 Node.js 信令服务 + 静态管理后台（零依赖）
│  ├─ src/                 config / logger / ws / signaling / admin / http
│  ├─ public/admin/        管理后台 SPA
│  ├─ public/call/         网页通话页
│  ├─ test/                联调测试（32 项）
│  └─ Dockerfile
├─ android/                Android 客户端（Kotlin + WebRTC）
│  └─ app/src/main/java/com/kszyd/vcall/
├─ docker-compose.yml      本地构建镜像启动
├─ docker-compose.hub.yml  直接拉取 Docker Hub 镜像启动
├─ .github/workflows/      APK 构建发布 / 镜像构建推送
└─ docs/                   接口协议与部署说明
```

## 一、后端部署（Docker）

目标机器：`192.168.199.100`，端口 `9002`。

### 方式 A：拉取 Docker Hub 镜像（推荐）

```bash
docker pull kszyd/vcall-server:latest

# 在仓库目录执行
docker compose -f docker-compose.hub.yml up -d
```

或不用 compose：

```bash
docker run -d --name vcall --restart unless-stopped \
  -p 9002:9002 \
  -e VCALL_ADMIN_PASSWORD='换成你的密码' \
  -e VCALL_ADMIN_SECRET='换成一串随机字符' \
  -v vcall-data:/data \
  kszyd/vcall-server:latest
```

### 方式 B：本地构建

```bash
docker compose up -d --build
```

### 访问

| 用途 | 地址 |
| --- | --- |
| 管理后台 | http://192.168.199.100:9002/admin |
| 网页通话 | http://192.168.199.100:9002/call |
| 健康检查 | http://192.168.199.100:9002/api/health |
| 信令地址 | ws://192.168.199.100:9002/ws |

默认管理账号：`admin` / `vcall@2026`（请通过 `.env` 或环境变量修改）。

复制 `.env.example` 为 `.env` 可集中配置密码、公告、STUN/TURN 等，compose 会自动读取。

## 二、Android 客户端

### 下载安装

- GitHub Release：`https://github.com/kszyd/vcall/releases/latest`
- 或从 Actions 产物 `VCall-APK` 下载

APK 使用 debug 签名，可直接安装并覆盖升级；电视可用 U 盘或 `adb install` 安装。

### 使用

1. 打开应用，服务器填 `192.168.199.100:9002`（默认已填）
2. 填写昵称与房间号（默认 `1001`）
3. 点击「加入房间」，另一台设备输入相同房间号即可接通
4. 遥控器：方向键移动焦点，确认键操作，返回键挂断

### 兼容性

- Android 6.0（API 23）及以上，手机与 Android TV
- 已裁剪 `armeabi-v7a`、`arm64-v8a`；如需 x86 模拟器，在 `app/build.gradle.kts` 的 `abiFilters` 中添加
- 电视无摄像头时可作为接收端加入（会提示「仅接收模式」）

## 三、配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VCALL_PORT` | `9002` | 服务端口 |
| `VCALL_ADMIN_USER` | `admin` | 管理用户名 |
| `VCALL_ADMIN_PASSWORD` | `vcall@2026` | 管理密码 |
| `VCALL_ADMIN_SECRET` | 随机 | 管理令牌签名密钥，生产必须固定 |
| `VCALL_MAX_ROOM_MEMBERS` | `2` | 单房间人数上限（2-8） |
| `VCALL_ANNOUNCEMENT` | 空 | 客户端公告 |
| `VCALL_STUN_URLS` | 空 | 逗号分隔的 STUN 地址 |
| `VCALL_TURN_URL` | 空 | TURN 地址，跨网段/防火墙时需要 |
| `VCALL_TURN_USER` / `VCALL_TURN_PASS` | 空 | TURN 账号 |
| `VCALL_DATA_DIR` | `/data` | 数据卷（设置持久化） |
| `VCALL_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

> 纯内网（同一网段、无客户端隔离）无需 STUN/TURN 即可直连。

## 四、本地开发

```bash
cd server
node src/index.js          # 启动服务，默认 9002
node test/signaling.test.js  # 运行 32 项联调测试
```

Android：

```bash
cd android
./gradlew assembleDebug     # 需要 JDK 17 与 Android SDK 35
```

## 五、自动化流水线

| 工作流 | 触发 | 产物 |
| --- | --- | --- |
| `Android APK` | 推送 `android/**` 或手动 | APK 制品 + 自动创建 `v1.0.0` Release |
| `Docker Image` | 推送 `server/**` 或手动 | `kszyd/vcall-server:latest` 多架构镜像（amd64/arm64） |

Docker Hub 凭据存放在仓库 Secrets：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`。

## 六、接口与协议

见 [docs/API.md](docs/API.md)：HTTP 管理接口与 WebSocket 信令消息定义。

## 七、常见问题

**电视安装后桌面不显示图标？**
确认使用支持 Leanback 的启动器；应用已声明 `LEANBACK_LAUNCHER` 与 banner。

**双方都显示「等待对方」？**
确认房间号一致、服务器地址可访问（浏览器打开 `/api/health` 验证）。

**画面卡顿或黑屏？**
内网建议 5GHz Wi-Fi；电视使用有线网络更稳。跨网段时需配置 TURN。

**忘记管理密码？**
修改 `.env` 中 `VCALL_ADMIN_PASSWORD` 后 `docker compose up -d` 重启。

## 安全说明

- 首次部署请修改默认密码与 `VCALL_ADMIN_SECRET`
- 服务默认使用明文 `http/ws`，仅建议在内网使用；如需公网访问，请置于 HTTPS 反向代理之后
- 管理令牌默认 12 小时有效，登录失败有限流

## License

MIT
