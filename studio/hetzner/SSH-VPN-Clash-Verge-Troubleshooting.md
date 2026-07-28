# Clash Verge 下通过 SSH 连接远程服务器

## 问题

目标服务器为 `94.130.98.119`，默认使用 SSH TCP `22` 端口。

- 未开启 Clash Verge/VPN：SSH 可以正常连接。
- 开启 Clash Verge/VPN：SSH 无法连接。

失败时的主要提示为：

```text
Connection established.
kex_exchange_identification: Connection closed by remote host
```

## 判断依据

排查远程服务器后确认：

- sshd 正常监听 TCP `22`。
- UFW 未启用。
- iptables 没有相关拦截规则。
- Fail2ban 没有封禁 VPN 出口 IP `65.20.68.187`。
- 远程 SSH 日志中没有来自该 VPN IP 的连接记录。

随后进行了对照测试：

```bash
# 通过 VPN 连接 GitHub SSH 的 22 端口
ssh -T git@github.com

# 通过 VPN 连接 GitHub SSH 的 443 端口
ssh -p 443 -T git@ssh.github.com
```

测试结果：

- GitHub TCP `22` 同样在 SSH 握手前被关闭。
- GitHub TCP `443` 可以完成 SSH 握手。

由此确认：当前 Clash 使用的 VPN/代理链路限制了 SSH TCP `22`，但允许 SSH TCP `443`。因此最终方案是让远程服务器的 sshd 同时监听 `22` 和 `443`，通过 VPN 时使用 `443`。

## 远程服务器配置

### 1. 确认 TCP 443 未被占用

```bash
sudo ss -ltnp | grep ':443 '
```

没有输出才能继续。如果 443 已被 Nginx、Caddy、Apache 等 HTTPS 服务占用，不能直接使用本方案。

### 2. 添加 SSH 443 端口

创建配置文件：

```bash
sudo nano /etc/ssh/sshd_config.d/10-port-443.conf
```

写入：

```text
Port 22
Port 443
```

保留 `22` 端口，避免新端口配置失败后失去原来的 SSH 连接方式。

### 3. 验证并重启 SSH

```bash
sudo sshd -t
sudo systemctl restart ssh
sudo ss -ltnp | grep -E ':(22|443) '
```

应当看到 sshd 同时监听：

```text
0.0.0.0:22
0.0.0.0:443
[::]:22
[::]:443
```

### 4. 配置 Hetzner Cloud Firewall

在 Hetzner Cloud Console 中，为服务器关联的 Firewall 添加入站规则：

```text
Direction:  Inbound
Protocol:   TCP
Port:       443
Source IPs: 65.20.68.187/32
```

`65.20.68.187` 是本次使用的 VPN 出口 IP。如果 VPN 出口 IP 发生变化，需要更新这条规则。

## 本地配置与连接

Clash Verge 不需要添加 `DIRECT` 规则。保持 Clash Verge/VPN 开启，直接使用 TCP `443`：

```bash
ssh -p 443 root@94.130.98.119
```

如果使用私钥：

```bash
ssh -p 443 -i ~/.ssh/PRIVATE_KEY root@94.130.98.119
```

为了避免每次输入端口，可以在 `~/.ssh/config` 中添加：

```sshconfig
Host hetzner-server
    HostName 94.130.98.119
    User root
    Port 443
    IdentityFile ~/.ssh/PRIVATE_KEY
```

以后使用：

```bash
ssh hetzner-server
```

如果使用密码登录，可以省略 `IdentityFile`。

## 最终结果

完成远程 sshd 和 Hetzner Cloud Firewall 配置后，本地在开启 Clash Verge/VPN 的情况下，已成功通过以下命令登录：

```bash
ssh -p 443 root@94.130.98.119
```

原 TCP `22` 端口继续保留，不使用 VPN 时仍可按原方式连接。
