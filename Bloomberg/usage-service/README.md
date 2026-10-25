# 翻译用量服务

家庭局域网地址：`http://192.168.50.71:18746`。Python 3.9+ 标准库与 SQLite，无第三方运行依赖。页面不引用外部字体、脚本或 CDN。

## 规则

- 已更新的 Bloomberg 模块在每次实际翻译前，POST provider、APP ID（百度）及 Unicode 字符数。原文、译文、百度密钥、签名及 Bloomberg 登录数据不发送到本服务。
- SQLite `BEGIN IMMEDIATE` 原子检查并预扣。每个百度 APP ID 按北京时间自然月限制 1,000,000 字符，多设备共用；请求超过剩余额度时整批拒绝，脚本使用 Google 备用。
- 首次启动所在月记录在数据库 settings 中；该月新出现的百度 APP ID 按已用完补录 1,000,000 字符。未来月份自动从 0 开始，不删除历史记录。重启不会重置额度。
- 配额是保守的放行预算。失败、超时、状态回报丢失不返还额度；它不是百度账单。成功回报字符、放行字符、被拦截次数分别展示；历史补录不计入调用总字数。
- reserve 的请求 ID 幂等；客户端不自动重试 provider 请求。百度在一次文章脚本内串行申请，首个错误后熔断，避免已排队但不会发出的请求先被记账。
- 服务不可用时不发起翻译，保留原文并提示。请求允许后若客户端退出，记录可能停留在“待回报”；额度仍被占用。
- 不缓存文章，不区分重复打开与唯一文章。调用次数指翻译批次，不能直接当作文章数。未更新设备、其他软件直接调用百度不受本服务控制，需停用旧版模块才能全面保护额度。

## 运行

```sh
python3 server.py
# 可选环境变量：PORT（默认18746）、USAGE_DB（默认data/usage.sqlite3）
```

mini 部署目录：`/Users/neptuno/services/translation-usage`。LaunchAgent：`com.neptuno.translation-usage`，登录自动启动，异常退出自动重启。日志位于该目录 `data/`。仅新增本服务，不改其他服务或反向代理。

SQLite 数据与密钥无关，但 APP ID 仍属于个人配置。`data/`、日志与数据库不上传 GitHub。备份时使用 SQLite backup API，避免仅复制活跃 WAL 数据库主文件。

## 接口

- `GET /health`：存活检查。
- `GET /api/stats?month=2026-10&offset=0`：每月/累计 provider 汇总、百度额度、每日数据、最近调用（每页100条）。无 month 时使用北京时间本月。
- `POST /api/reserve`：JSON `{id,provider,appid,characters}`。`id` 为 16–100 位字母数字、横线或下划线；字符数 1–6000。返回 `{id,allowed,remaining,code}`。Google 的 appid 为空。
- `POST /api/complete`：JSON `{id,state,error}`；state 为 success 或 failed，error 只接受简短错误码。只允许 reserved 状态更新一次。

仅供可信家庭局域网，无登录认证，不映射公网端口。网页跨源写入被拒绝，无 CORS；原生 Surge 调用无 Origin。局域网其他原生客户端仍可读写账本，因此这不是对恶意客户端的鉴权系统。

## 验证

```sh
python3 -m unittest discover -s tests -v
node --test ../tests/*.test.cjs
```

测试使用临时数据库和模拟 provider，不消耗百度额度，覆盖并发边界、跨月、APP ID 隔离、幂等、故障回退、字段隐私。
