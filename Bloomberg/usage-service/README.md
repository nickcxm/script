# Mini 翻译服务与文章存档

地址：`http://192.168.50.71:18746`。Python 3.9+ 标准库、SQLite 与 macOS 26+ Translation.framework，无 Python 第三方依赖。默认 Apple 本机英译中，失败时百度 → Google；优先 provider 可以在管理页修改。

## 安装语言包

在 mini 的系统设置 → 通用 → 语言与地区 → 翻译语言，下载英语和简体中文。下载完成后点击管理页“检测语言包”。系统 API 无界面初始化需要语言包已安装；本服务不会自动弹出下载许可。

## 部署和启动

目录：`/Users/neptuno/services/translation-usage`。

```sh
mkdir -p bin
xcrun swiftc -parse-as-library -O AppleTranslate.swift -o bin/apple-translate
python3 server.py
```

可选环境变量：`PORT` 默认 18746；`USAGE_DB` 默认 `data/usage.sqlite3`。

- LaunchAgent `com.neptuno.translation-usage` 设置 RunAtLoad 和 KeepAlive，用户登录后自动运行，异常退出自动重启。Apple 语言包属于该用户环境；不是登录前的系统级 daemon。
- mini 的 `~/Downloads/启动翻译服务.command` 双击启动并打开页面。先检查已有进程，避免重复实例；缺少或更新 Swift 程序时自动编译。
- 当前控制 Mac 的 `~/Downloads/启动Mini翻译服务.command` 通过已经配置的 `ssh mini` 启动远程服务，再在本机打开页面。对应源码为 launch-mini.command。
- 两个启动脚本均支持 `--no-open`，用于验证启动而不打开浏览器。
- 不修改其他服务或反向代理。只绑定本机网络端口，没有公网域名或端口映射。

## 翻译、缓存与持久化

`POST /api/translate` 接收一篇文章。标题编号为内部 0，正文 ID 为正整数。Apple 用 clientIdentifier 保证对应关系；百度/Google 按 2000/1200 字符打包，百度额外限制 5800 UTF-8 字节。编号匹配失败保留合并范围，不强行对应。

按文章版本与优先 provider 建立内容键，完整结果跨设备缓存，并合并同时到达的相同请求。未完成的结果保存为 partial，不作为完整缓存。重复打开不会重新调用引擎。长段落某个片段失败时，该段完整原文交给备用服务，避免把部分译文误当成完成。

数据库 `articles` 保存英文/中文标题、原文、译文、来源 URL、来源 ID、来源发布时间/更新时间、保存时间、provider、缓存命中与完成状态。详情 API 返回结构化原文及译文范围，方便后续接入 RSS/Atom/Reeder；目前没有外部推送。

配置在 `data/config.json`（600 权限），只保存优先 provider 与百度 APP ID/密钥。GET 配置只返回“是否已配置密钥”，不返回密钥。留空保持旧密钥，勾选清除才删除。

## 额度和统计

每次引擎调用前按 provider、APP ID、Unicode 字符数登记。百度 SQLite BEGIN IMMEDIATE 原子检查并预扣，每个 APP ID 按北京时间自然月最多 1,000,000 字符，多设备共享。首次上线月记录在 settings，该月 APP ID 按此前已用完补录 1,000,000；重启不重置，下个月从 0 开始。

失败/超时不返还预扣，以免请求已到百度后重复释放。页面分别显示放行字符、成功字符、失败与拦截，实际计费仍以百度账单为准。缓存命中单独统计，不伪造引擎调用。所有百度请求共用串行队列及150ms最小间隔，Google全服务最多3路并发，文章工作最多8项。

保留 `/api/reserve`、`/api/complete` 兼容旧版 Surge。旧版只上传统计，没有文章存档与共享译文；所有设备都要更新模块。其他软件直接访问百度不受本服务控制。

## 接口

- `GET /health`：版本、存活与北京时间月份。
- `GET /api/config`：优先 provider、百度 APP ID、密钥是否已配置、Apple 状态。
- `POST /api/config`：`provider`、`baidu_appid`、`baidu_key`、`clear_baidu_key`。
- `POST /api/translate`：`{article:{id,title,url,updatedAt,publishedAt},paragraphs:[{id,text}]}`，仅接受 Bloomberg HTTPS 来源 URL。服务不会抓取该 URL。
- `GET /api/articles?offset=0`：每页30个文章版本及缓存汇总。
- `GET /api/articles/<64位内容键>`：标题、来源、原文与结构化译文。
- `GET /api/stats?month=2026-10&offset=0`：月度/累计 provider、每日数据、百度额度、每页100条引擎调用。新增记录关联文章及耗时。
- `POST /api/reserve` / `POST /api/complete`：旧版元数据记账兼容接口。

## 隐私和运行边界

仅限可信家庭局域网，没有账户认证。网页跨源 POST 被拒绝，无 CORS；原生局域网客户端仍可访问接口，不是针对恶意客户端的授权系统。不要映射公网。

文章和凭证留在 mini 的私有 data 目录（700）。百度/Google 仅收到实际提交的待译内容与各自必需参数；不接收或转发 Bloomberg Cookie、登录凭证或请求头。Apple worker 使用固定英中系统接口，不联网获取文章，不读取配置密钥。页面不引用外部字体、脚本或 CDN。

数据库、WAL、配置、日志、二进制均被 gitignore 排除。升级前使用 SQLite backup API 备份数据库，并保留旧源码包于 data/backups。备份时不要只复制活跃 WAL 数据库主文件。

## 测试

```sh
python3 -m unittest discover -s tests -v
node --test ../tests/*.test.cjs
```

回归测试使用临时数据库和模拟 provider，不消耗百度额度，覆盖并发边界、跨月、APP ID 隔离、缓存与在途去重、文章版本、凭证隐私、长段失败回退、编号降级。实际部署另验证 Apple 语言包、英中批量翻译、缓存以及启动器幂等。

平均耗时按 provider 分别提供本月与累计值，仅计算有耗时记录的成功调用，并展示有效样本数；缓存命中和无耗时的历史记录不计入均值。每千字符耗时按成功样本总耗时 / 总字符数加权计算。新后端使用实际引擎调用耗时；仍使用旧脚本的新请求以预约到完成的时间估算，包含少量局域网记账往返。
