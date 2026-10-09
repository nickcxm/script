# 来源审查记录

审查日期：2026-10-09。范围为 Maasea 的 `YouTube.Enhance.sgmodule` 和它直接引用的两个 JS，不是仓库中其他应用的所有脚本，也不包括 Cloudflare Worker 服务端实现。

对应上游提交：`65075cdb388fc5e3094afd7e7314c67b243f3525`。

| 文件 | 文件内 Build 标记 | SHA-256 |
| --- | --- | --- |
| `Script/Youtube/youtube.response.js` | `2026/7/19 16:16:39` | `f98483d5f5017514f82502253c0db5ce2d4ffb7839887aa2cadc22666f5a7f12` |
| `Script/Youtube/youtube.request.js` | `2026/7/12 22:44:32` | `3ecca15e06e76a31720092c581180f648ef2c45e494644941ba985c878efbb26` |

固定版本来源：

- [模块配置](https://github.com/Maasea/sgmodule/blob/65075cdb388fc5e3094afd7e7314c67b243f3525/YouTube.Enhance.sgmodule)
- [响应脚本](https://github.com/Maasea/sgmodule/blob/65075cdb388fc5e3094afd7e7314c67b243f3525/Script/Youtube/youtube.response.js)
- [请求脚本](https://github.com/Maasea/sgmodule/blob/65075cdb388fc5e3094afd7e7314c67b243f3525/Script/Youtube/youtube.request.js)

## 实际执行行为

响应脚本包含 Protobuf 运行库和消息字段定义，业务路径清理广告、设置播放能力、添加翻译字幕、过滤导航项、修改设置，并从 `config/log_event` 响应的 Onesie 配置中读取 `clientKey/encryptKey`，保存到 `YouTubeConfig`。广告分类也会存入 `YouTubeAdvertiseInfo`。

请求脚本在 `log_event` 上去掉 `content-encoding`，缺少缓存密钥时还会去掉 `x-youtube-hot-hash-data`。在指定 `initplayback` 请求上比较加密客户端密钥：匹配时，构造指向 `https://init-stream.maasea.workers.dev/` 的请求 URL，其中查询参数 `ck` 携带缓存的客户端密钥，`target` 携带原播放 URL，另附增强参数；不匹配或无缓存时返回空的 200 响应，并清理缓存配置。

这能确认特定条件下存在第三方播放处理依赖，不能据此断定作者恶意。未审查远程 Worker 内部如何处理或保留数据，也没有请求该 Worker。

原脚本具有跨代理工具的网络、通知和存储适配器。网络 API 出现在通用适配器中不代表每条响应处理都会主动发请求；上述 Worker 路径通过 `$done({url: ...})` 让 Surge 重定向请求。

未在这两个版本中发现 `eval`、`new Function` 或动态 `import` 调用。这不是全面安全保证，后续远程版本可能变化。

## 本实现的边界

新实现的业务处理与 wire codec 可直接阅读；协议字段号参考上游定义，因此保留来源说明和 Apache-2.0 许可。

本实现不执行或打包上游 JS，不依赖作者 Worker，不收集客户端密钥，不使用持久化存储。只有 `.sgmodule` 通过 GitHub Raw 下载本仓库的两个脚本，运行后响应处理在本地完成。

加密 UMP 的 Worker 解密与流修改没有移植；采用用户选择的本地回退策略。若客户端不接受空响应回退，可能导致无法播放。需要实机验证，不能把离线测试通过当作完整功能等效证明。
