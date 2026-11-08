# 部署说明

## 1. 前置条件

- 一台内网服务器（示例 `192.168.199.100`），安装 Docker 20+ 与 Docker Compose v2
- 防火墙放行 TCP `9002`
- 手机/电视与该服务器同一网段，且路由器未开启「AP 隔离」

## 2. 拉取镜像部署

```bash
mkdir -p /opt/vcall && cd /opt/vcall
curl -O https://raw.githubusercontent.com/kszyd/vcall/main/deploy/docker-compose.yaml
docker compose -f docker-compose.yaml up -d
docker compose -f docker-compose.yaml logs -f
```

数据会保存在当前目录的 `./data`。

验证：

```bash
curl http://192.168.199.100:9002/api/health
```

## 3. 使用本地构建

```bash
git clone https://github.com/kszyd/vcall.git
cd vcall
docker compose up -d --build
```

## 4. 修改管理密码

直接编辑 `deploy/docker-compose.yaml` 的 `environment` 段（不使用 `.env`）：

```yaml
    environment:
      VCALL_ADMIN_USER: "admin"
      VCALL_ADMIN_PASSWORD: "YourStrongPassword"
      VCALL_ADMIN_SECRET: "随机长字符串（可用 openssl rand -hex 32 生成）"
```

重启生效：

```bash
docker compose -f deploy/docker-compose.yaml up -d --force-recreate
```

## 5. 数据持久化

- 绑定目录 `./data`（与 compose 文件同级，即 `deploy/data`）挂载到容器 `/data`
- 保存 `settings.json`（管理端修改的公告/人数上限）与可选日志
- 备份：`tar czf vcall-data.tar.gz -C deploy/data .`

## 6. 跨网段 / 公网访问（可选）

WebRTC 需要媒体通路。同一内网通常可直连；跨网段或存在防火墙时部署 TURN：

```bash
docker run -d --name coturn --network host \
  -e TURN_USER=vcall -e TURN_PASSWORD=yourpass \
  -e TURN_REALM=example.lan \
  coturn/coturn
```

在 VCall 中配置：

```ini
VCALL_TURN_URL=turn:192.168.199.100:3478
VCALL_TURN_USER=vcall
VCALL_TURN_PASS=yourpass
```

## 7. HTTPS（浏览器摄像头必需）

浏览器只在 HTTPS 或 localhost 下允许访问摄像头/麦克风。除反向代理外，服务端已内置可选 HTTPS：

```bash
./scripts/gen-cert.sh 192.168.199.100
```

在 `deploy/docker-compose.yaml` 中填写：

```yaml
      VCALL_TLS_CERT: "/certs/server.crt"
      VCALL_TLS_KEY: "/certs/server.key"
```

重启后访问 `https://192.168.199.100:9443/call`，首次需在浏览器信任自签证书。若不加证书，网页端仍可用「仅接收加入」观看对方画面。

### 反向代理方式（可选）

若需通过域名访问，可使用 Nginx：

```nginx
server {
    listen 443 ssl;
    server_name vcall.example.com;

    location / {
        proxy_pass http://127.0.0.1:9002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

WebSocket 必须保留 `Upgrade`/`Connection` 头；客户端把服务器地址填成 `https://vcall.example.com` 即可（App 会自动转换为 `wss://`）。

## 8. 群晖 / 威联通

- 套件中心安装 Container Manager（Docker）
- 项目 → 新增 → 选择 `docker-compose.hub.yml` 内容
- 端口映射 `9002:9002`，卷映射 `vcall-data:/data`
- 或直接 `docker run` 命令（见 README）

## 9. 升级

```bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
```

数据卷保留，配置不受影响。

## 10. Kubernetes（YAML）

清单文件：`deploy/k8s.yaml`，包含 Namespace、Secret、ConfigMap、PVC、Deployment、Service。

```bash
kubectl apply -f deploy/k8s.yaml
kubectl -n vcall get pods,svc
kubectl -n vcall rollout status deploy/vcall
```

- Deployment 使用 `hostPort: 9002`，`replicas` 必须为 1，节点 IP 直接访问 `http://192.168.199.100:9002`
- PVC 需要默认 StorageClass；若没有，请在 PVC 中指定 `storageClassName`
- 管理密码与令牌密钥位于 Secret，修改后重新 `kubectl apply` 并 `rollout restart deploy/vcall`
- 多节点或需域名访问时，改用 NodePort/Ingress 并移除 `hostPort`

## 11. 排障

| 现象 | 排查 |
| --- | --- |
| 容器反复重启 | `docker logs vcall`，检查端口占用 |
| 管理页打不开 | `curl /api/health`；确认 9002 未被防火墙拦截 |
| 能加入但无画面 | 两端是否在同网段；路由器 AP 隔离；必要时加 TURN |
| 电视无摄像头 | 属正常，App 以仅接收模式加入 |
| 管理登录过期 | 固定 `VCALL_ADMIN_SECRET`，否则重启后令牌失效 |
