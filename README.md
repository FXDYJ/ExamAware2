# ExamAware2 知试

一款易用、跨平台的大屏考试信息展示工具.

## 公网 IP 直连版

从 [此 fork 的发布页](https://github.com/FXDYJ/ExamAware2/releases/tag/control-v0.1.5) 下载 `ExamAware-1.6.3-public-ip-setup.exe`。
在已安装 Docker Engine 和 Docker Compose 插件的 Linux 服务器上运行以下命令。
将 `192.0.2.10` 替换为服务器的公网 IP。

```bash
curl -fsSL https://github.com/FXDYJ/ExamAware2/releases/download/control-v0.1.5/install.sh -o /tmp/examaware-control-install.sh && \
  EXAMAWARE_NONINTERACTIVE=1 BETTER_AUTH_URL=http://192.0.2.10:8219 HTTP_PORT=8219 \
  bash /tmp/examaware-control-install.sh control-v0.1.5
```

在服务器防火墙和云安全组放行 `8219/TCP`。安装结束后会显示自动生成的管理员密码。
浏览器和客户端「学校集控」都填写同一个 `http://公网IP:8219`，IPv6 用方括号包住地址。
HTTP 会明文传输凭据。部署配置保存在 `/opt/examaware-control/.env`，PostgreSQL 数据保存在 Docker 命名卷。

### 无人值守

提前上传考试档案并分配设备，在考试详情的「无人值守」中设置自动准备、自动开始放映、自动结束放映三个时间。
新建考试默认先保存档案，可在详情中设置计划。时间按浏览器所在时区显示，保存时转换为 UTC。
计划固定使用保存时的档案版本和目标设备，重复时间范围内的计划不能占用同一设备。

「考试管理 → 无人值守总览」集中显示执行计划、最近异常和执行时间。考前检查可核验连接状态、客户端能力和时钟同步，结束后未收到放映确认的设备也会保留提示。

需要应对断网时，勾选「下载后由客户端离线定时执行」。1.6.3 客户端会持久化已校验的档案和计划，并使用校时结果本地开始、结束放映；应用重启后也会恢复有效计划。修改或取消计划需要客户端重新联网才能同步。
可设置允许迟上线的分钟数，超过截止时间不会开始旧考试；0 表示一直允许到结束前。客户端在集控放映期间保持屏幕常亮，结束后释放系统休眠限制。

集控镜像默认通过 `02658d00530d8704a51263b4ee0e716d.d.1ms.run` 拉取。安装器升级时会迁移原来的 `ghcr.io`、`ghcr.1ms.run` 配置，保留自定义私库。

计划保存后可以关闭后台，服务器每 2 秒检查数据库。服务重启后继续执行有效计划，已经过了结束时间的计划会结束。
在线且准备完成的设备到点开始，迟上线设备在配置的截止时间前会自动补发和开始。失败的设备命令间隔 15 秒重试。
到结束时间自动下发停止命令，也可随时在详情中「取消计划并停止」。客户端须保持运行，自动开机与登录由教室电脑配置。

隐藏巡考按钮时，在「设备策略」新建或编辑一条策略，添加「显示呼叫巡考按钮」并设为关闭，再将策略应用到目标设备或设备组。
此选项需要本 fork 的 1.6.2 客户端，设置为开启可恢复按钮。

已有 Docker 安装运行以下命令升级。安装器会沿用已有地址、端口、设备凭据配置，并在升级前备份数据库。

```bash
curl -fsSL https://github.com/FXDYJ/ExamAware2/releases/download/control-v0.1.5/install.sh -o /tmp/examaware-control-install.sh && \
  bash /tmp/examaware-control-install.sh control-v0.1.5
```

![1764471277655](image/README/1764471277655.png)

![1764471408023](image/README/1764471408023.png)

![1764471428131](image/README/1764471428131.png)

## 启动开发模式

```bash
pnpm i
pnpm dev
```

或：

```bash
pnpm web:dev
```

## 集控服务开发

集控服务的 PostgreSQL 开发库由根目录的 `compose.yml` 管理。数据库端口、用户名、密码和库名与控制服务的开发默认值一致，无需额外配置。

```bash
# 首次启动或恢复开发数据库；命名卷会保留数据
pnpm control:db:up

# 应用数据库迁移
pnpm control:db:migrate

# 启动集控服务
pnpm control:dev
```

首次部署空数据库时，构建服务并创建首位管理员：

```bash
pnpm control:build
CONTROL_ADMIN_EMAIL=admin@example.edu \
CONTROL_ADMIN_NAME="School administrator" \
CONTROL_ADMIN_PASSWORD="replace-with-a-strong-password" \
pnpm control:bootstrap-admin
```

停止数据库但保留数据：

```bash
pnpm control:db:down
```

## 用户讨论社区

QQ 群： 901670561

智教联盟论坛板块：[ExamAware 板块](https://forum.smart-teach.cn/t/examaware)
