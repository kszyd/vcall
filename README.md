# VCall · 内网视频通话（Android 6+ 手机 / 电视）

前后端分离的内网视频通话方案：连上服务器即登录，所有在线终端自动出现在通讯录，点选即可一对一或多人视频通话。**Node.js 信令服务 + Web 管理后台** 用 Docker 部署，**Android APK** 覆盖手机与电视（minSdk 23）。默认服务地址 `http://192.168.199.100:9002`。

## 直达链接

| 内容 | 地址 |
| --- | --- |
| 源码仓库 | https://github.com/kszyd/vcall |
| APK 下载 | https://github.com/kszyd/vcall/releases/latest |
| 容器镜像 | https://hub.docker.com/r/kszyd/vcall-server |
| 更新记录 | [CHANGELOG.md](CHANGELOG.md) |

## 验证情况

- 服务端 44 项联调测试全部通过：终端注册、通讯录同步、一对一/多人呼叫、拒接、离开、管理员下线、鉴权与静态资源
- 管理后台已在 Chromium 中完成登录、仪表盘与日志渲染验证
- APK 由 GitHub Actions 构建成功：含 `arm64-v8a` / `armeabi-v7a` 原生库、v1+v2 签名、Leanback 启动声明
- 尚未验证：真机摄像头/麦克风通话、电视实机安装（缺少测试设备）

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

- 仿微信通讯录：登录后自动列出所有在线终端（头像、昵称、平台、状态），支持搜索
- 点选终端即可发起视频通话；勾选多个终端可发起多人通话（Mesh，默认上限 6 人）
- 来电界面接听/拒绝，45 秒无应答自动取消；对方忙或离线有明确提示
- 多人通话网格布局：1 人全屏、2-4 人 2×2、5-6 人 3×2，右上角本地小窗
- 视频默认 1080p 采集、码率上限 12 Mbps，画质优先（带宽不足时先降帧率、保持分辨率）
- 静音 / 翻转 / 挂断 / 免提，通话计时与网络质量提示（网络良好 / 网络不佳）
- 遥控器操作：方向键移动焦点、确认键操作、返回键挂断；电视端按钮与字号自动放大
- 管理后台：在线终端、进行中通话、强制下线、通话记录、日志、公告、人数上限、APK 版本推送
- 网页端同一套通讯录模式，电脑或电视浏览器可直接使用
- 心跳保活、断线提示、在线状态自动同步
- 零第三方依赖的服务端（无 npm install 步骤），镜像约 48 MB

### 客户端版本推送

管理后台「客户端版本」卡片可上传新 APK：

1. 选择 APK 文件，填写版本名（如 `2.10.0`）与版本码（如 `17`，必须大于服务端当前版本码）
2. 点「上传并推送」，文件保存到数据目录 `data/apk/`，在线终端立即收到 `apk-update` 消息
3. 终端每次打开并连上服务器时（`welcome` / `registered` 消息）都会比对版本码，低于服务端即弹窗提示下载
4. 下载地址固定为 `http://<服务器>/api/apk/download`，任何终端都能直接下载安装

## 目录结构

```
vcall/
├─ server/                 Node.js 信令服务 + 静态管理后台（零依赖）
│  ├─ src/                 config / logger / ws / signaling / admin / http
│  ├─ public/admin/        管理后台 SPA
│  ├─ public/call/         网页通话页
│  ├─ test/                联调测试（34 项）
│  └─ Dockerfile
├─ android/                Android 客户端（Kotlin + WebRTC，微信式界面）
│  └─ app/src/main/java/com/kszyd/vcall/
├─ deploy/
│  ├─ docker-compose.yaml  Docker Compose 部署（YAML）
│  └─ k8s.yaml             Kubernetes 部署清单（YAML）
├─ docker-compose.yml      本地构建镜像启动
├─ docker-compose.hub.yml  直接拉取 Docker Hub 镜像启动
├─ .github/workflows/      APK 构建发布 / 镜像构建推送
└─ docs/                   接口协议与部署说明
```

## 一、后端部署（Docker）

目标机器：`192.168.199.100`，端口 `9002`。

### 方式 A：拉取 Docker Hub 镜像（推荐）

标准 YAML 部署文件：`deploy/docker-compose.yaml`

```bash
docker pull kszyd/vcall-server:latest

# 在仓库目录执行
docker compose -f deploy/docker-compose.yaml up -d
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

### 方式 C：Kubernetes（YAML）

清单文件：`deploy/k8s.yaml`（Namespace / Secret / ConfigMap / PVC / Deployment / Service）

```bash
kubectl apply -f deploy/k8s.yaml
kubectl -n vcall rollout status deploy/vcall
```

- Deployment 使用 `hostPort: 9002`，因此 `replicas` 固定为 `1`，节点 IP 可直接访问 `http://192.168.199.100:9002`
- 若集群没有默认 StorageClass，请为 PVC 指定 `storageClassName`
- 管理密码与令牌密钥在 `Secret` 中修改后重新 apply

### 访问

| 用途 | 地址 |
| --- | --- |
| 管理后台 | http://192.168.199.100:9002/admin |
| 网页通话 | http://192.168.199.100:9002/call |
| 健康检查 | http://192.168.199.100:9002/api/health |
| 信令地址 | ws://192.168.199.100:9002/ws |

默认管理账号：`admin` / `vcall@2026`（请直接修改 YAML 中的 `VCALL_ADMIN_PASSWORD`）。

所有配置直接写在 `deploy/docker-compose.yaml` 的 `environment` 中，不使用 `.env` 文件；数据目录为 `deploy/data`（即相对 compose 文件的 `./data`）。

### 网页端摄像头权限（重要）

浏览器只在**安全上下文**（HTTPS 或 localhost）下允许 `getUserMedia`。直接打开 `http://192.168.199.100:9002/call` 时，页面会提示改用「仅接收加入」（可正常观看对方画面，但本机不采集）。

网页端双向通话使用内置 HTTPS（默认已启用，监听 9443）：

1. 把证书放到 compose 同级的 `certs/` 目录：`certs/server.crt`、`certs/server.key`
   - 仓库附带 `scripts/gen-cert.sh 192.168.199.100` 可自行生成
   - 也可直接使用项目提供的证书文件（SAN 已包含 `192.168.199.100`）
2. `docker compose -f deploy/docker-compose.yaml up -d`
3. 浏览器访问 `https://192.168.199.100:9443/call`，首次提示证书不受信任时选择「高级 → 继续访问」

Android APK 使用原生 WebRTC，走 9002 的 HTTP/WS 即可，不受此限制。

## 二、Android 客户端

### 下载安装

- GitHub Release：`https://github.com/kszyd/vcall/releases/latest`
- 或从 Actions 产物 `VCall-APK` 下载

APK 使用 debug 签名，可直接安装并覆盖升级；电视可用 U 盘或 `adb install` 安装。

### 使用

1. 打开应用，服务器地址已预填 `192.168.199.100:9002`
2. 填写昵称，点「进入通讯录」（无需账号密码）
3. 通讯录会自动列出同一服务器下的其他终端（头像、昵称、平台、状态）
4. 点击某个终端即可发起视频通话；勾选多个终端后点「呼叫所选」发起多人通话
5. 对方接听后进入通话；底部四个圆钮：静音、翻转、挂断、免提
6. 电视遥控器：方向键移动焦点（按钮高亮），确认键执行，返回键挂断；电视端控件自动放大

### 兼容性

- Android 6.0（API 23）及以上，手机与 Android TV
- **Android 4.x 无法支持**：所用 WebRTC 库（io.github.webrtc-sdk）要求 API 21+，且 4.x 的摄像头与 EGL 兼容性不足；本项目按 Android 6.0 维护
- 已裁剪 `armeabi-v7a`、`arm64-v8a`；如需 x86 模拟器，在 `app/build.gradle.kts` 的 `abiFilters` 中添加
- 电视无摄像头时仍可登录通讯录，接听后可观看对方画面

## 三、配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| **管理后台** | | |
| `VCALL_ADMIN_PASSWORD` | `vcall@2026` | 登录密码，部署前务必修改 |
| `VCALL_ADMIN_SECRET` | 随机 | 令牌签名密钥，建议固定为随机长串 |
| **通话** | | |
| `VCALL_MAX_CALL_MEMBERS` | `6` | 单次通话人数上限（2-12） |
| `VCALL_ANNOUNCEMENT` | 空 | 公告，也可在管理后台推送 |
| **可选（跨网段/公网）** | | |
| `VCALL_TURN_URL` / `VCALL_TURN_USER` / `VCALL_TURN_PASS` | 空 | TURN 地址与账号 |
| `VCALL_STUN_URLS` | 空 | 自定义 STUN，逗号分隔 |
| **高级** | | |
| `VCALL_PORT` | `9002` | 容器内服务端口 |
| `VCALL_ADMIN_USER` | `admin` | 管理用户名 |
| `VCALL_DATA_DIR` | `/data` | 数据目录（设置持久化） |
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
| `Android APK` | 推送 `android/**` 或手动 | APK 制品 + 自动创建对应版本号的 Release |
| `Docker Image` | 推送 `server/**` 或手动 | `kszyd/vcall-server:latest` 多架构镜像（amd64/arm64） |

Docker Hub 凭据存放在仓库 Secrets：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`。

## 六、接口与协议

见 [docs/API.md](docs/API.md)：HTTP 管理接口与 WebSocket 信令消息定义。

## 七、常见问题

**电视安装后桌面不显示图标？**
确认使用支持 Leanback 的启动器；应用已声明 `LEANBACK_LAUNCHER` 与 banner。

**通讯录里看不到对方？**
确认两台终端填写的是同一服务器地址，且都能访问 `/api/health`；终端离线或昵称被搜索框过滤也会看不到。

**画面卡顿或黑屏？**
内网建议 5GHz Wi-Fi；电视使用有线网络更稳。跨网段时需配置 TURN。

**忘记管理密码？**
修改 `deploy/docker-compose.yaml` 中的 `VCALL_ADMIN_PASSWORD`，再执行 `docker compose -f deploy/docker-compose.yaml up -d --force-recreate`。

## 安全说明

- 首次部署请修改默认密码与 `VCALL_ADMIN_SECRET`
- 服务默认使用明文 `http/ws`，仅建议在内网使用；如需公网访问，请置于 HTTPS 反向代理之后
- 管理令牌默认 12 小时有效，登录失败有限流

## License

MIT
