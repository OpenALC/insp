# insp-sync-server

Linux 上的密文同步服务。二进制名称为 `insp-sync-server`。服务只保存 opaque header 和客户端加密后的 envelope，不持有解密密钥；空间凭证以 SHA-256 哈希保存，不记录或保存明文 token。

## Linux Docker 启动

在 Linux 主机安装 Docker Engine 和 Docker Compose 插件后，在本目录运行：

```sh
docker compose -f compose.yml up -d --build
```

Compose 将容器端口仅发布到主机 `127.0.0.1:8787`，数据写入名为 `insp-sync-data` 的持久卷。容器以 UID/GID `10001` 的非 root 用户运行。应用启动时输出实际监听地址，包括配置端口为 `0` 时操作系统分配的端口。

本地直接运行时，`INSP_LISTEN` 默认是 `127.0.0.1:8787`，`INSP_DATA_DIR` 默认是 `./data`：

```sh
INSP_LISTEN=127.0.0.1:8787 INSP_DATA_DIR=./data cargo run --release --bin insp-sync-server
```

Docker 镜像将监听地址设为容器内的 `0.0.0.0:8787`，数据目录设为 `/data`；Compose 的端口映射仍只允许主机本地访问。

## HTTPS 反向代理

同步流量应通过 TLS 反向代理。将域名 DNS 指向主机，并在防火墙开放代理所需的 80/443 端口。若使用主机上的 Caddy，可配置：

```caddyfile
sync.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 会为该域名提供 HTTPS，代理连接到仅绑定主机回环地址的服务端口。不要将容器端口改为公网发布。

## 备份

先停止服务以获得一致的 SQLite 文件副本，再归档整个数据卷：

```sh
docker compose -f compose.yml stop
mkdir -p backups
docker run --rm \
  -v insp-sync-data:/data:ro \
  -v "$PWD/backups:/backup" \
  busybox:1.36 sh -c 'tar -czf /backup/insp-sync-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .'
docker compose -f compose.yml start
```

备份文件包含整个 SQLite 数据目录。将备份复制到受控的异机存储，并定期检查能否解档恢复。
