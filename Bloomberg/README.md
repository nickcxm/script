# Bloomberg 中英对照：mini 后端翻译与文章存档

Surge 负责提取文章并回填 JSON，翻译、缓存、去重、百度额度控制与文章存档统一在自己的 Mac mini 执行。默认使用 Apple 本机英译中，失败时依次尝试百度和 Google。

## 安装与更新

在所有设备的 Surge 中安装或更新同一个模块：

```text
https://raw.githubusercontent.com/nickcxm/script/main/Bloomberg/Bloomberg.Translate.sgmodule
```

模块版本：`20261031-v1-v2-1`。JS 固定到已验证的提交；更新已有模块才能取得新脚本地址。

启用 MITM 并信任 Surge 证书。只匹配以下 GET 接口的 HTTP 200 JSON：

```text
https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/<14位大写字母或数字的ID>
https://cdn-mobapi.bloomberg.com/wssmobile/v2/stories/<14位大写字母或数字的ID>
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| enabled | true | 是否启用 |
| usage_host | 192.168.50.71 | mini 服务 IPv4 地址 |
| usage_port | 18746 | mini 服务端口 |
| remove_ad_config | true | 删除 adParams；已有 disableAds 设为 true |
| debug | false | 只输出版本、provider、缓存命中和段落数量 |

百度凭证和优先 provider 改在管理页配置：`http://192.168.50.71:18746`。新脚本不使用旧模块的百度密钥参数，正常翻译由后端处理；后端不可用或有缺失段落时，设备端直接使用 Google 最终备用。旧版脚本保留用于历史兼容，但未更新的设备仍走旧流程，不能享受后端翻译缓存和正文存档。

优先使用 mini 时，设备需能访问其地址；外出可沿用已有家庭 VPN/Ponte 等访问方式，或直接使用最终 Google 备用。后端请求不强制 DIRECT，会遵循现有 Surge 规则，包括已配置的 Ponte/VPN 路由。普通局域网访问不要求域名；如果浏览器能访问但旧脚本不能，需先更新去掉强制 DIRECT 的版本。后端不可达时设备直接使用 Google 备用；不依赖后端记账或存档。

## 展示

- v1 使用 `components` 中 `role:p` 的 `parts/text`；v2 使用 `structuredData.data` 中 `type:paragraph` 的 `content/value`。每段先拼接所有正文及嵌套实体/链接文字，嵌套内容优先于重复的回退文字。两种版本都保留图片、图表、链接与未知字段，不把 v2 转换成 v1 JSON。
- 原文保留链接与图片位置，英文与中文使用 `1.` 等编号。译文作为同一段落末尾的文本片段追加（v1 为 `role:text/text`，v2 为 `type:text/value`），单个换行分隔，不为每段额外创建段落。
- 标题直接显示英文原标题与中文标题。
- Apple 批量接口以 clientIdentifier 精确匹配段落。百度/Google 继续使用带编号的批次；编号异常时保留合并译文与对应范围，不猜测逐段关系。
- 默认 Apple 或百度成功不显示 provider；使用 Google 时在第一段后显示一次服务说明，错误也集中在第一段后显示。
- 只发送标题和正文段落；摘要、作者、图片说明、嵌入 HTML 和其他非正文组件不翻译。
- 保留现有广告配置清理；不修改订阅、付费墙或文章访问权限。

## 后端与存档

后端对每个文章内容版本、语言方向和优先 provider 生成内容键。完整译文跨设备复用，重复请求合并为同一项在途工作；缓存命中不再调用引擎或占用百度预算。部分失败的文章仍保存原文和已取得译文，但不会当作完整缓存。

保存内容包括：来源文章 ID、规范来源 URL、源更新时间/发布时间、英文标题、中文标题、每个正文段落、对应译文范围、实际 provider、首次保存/最近访问时间、缓存命中次数和完成状态。内容更新保留新版本。页面可以打开中英对照全文；JSON 详情接口保留这些字段，便于以后生成 RSS/Atom 或接入 Reeder，目前不会自动推送。

Apple 使用系统 Translation.framework，英中语言包需提前在 mini 的“系统设置 → 通用 → 语言与地区 → 翻译语言”下载。常驻 Swift 子进程避免每次启动模型。

百度每个 APP ID 按北京时间自然月最多放行 1,000,000 字符；本服务首次上线的月份按此前已用完初始化，之后月份从零开始。SQLite 原子预扣，失败/超时不自动退回。服务内所有百度请求共享串行队列及 150ms 最小发起间隔。Google 共享三路并发；百度失败的内容按更小批次使用 Google 备用。

## 数据边界

Surge 只上传待翻译的标题、正文段落、来源链接及来源时间，不转发 Bloomberg Cookie、Authorization、设备信息或原请求头。数据和译文保存在用户自己的 mini；百度或 Google 实际参与时会收到对应待译文本。Apple 路径调用本机系统翻译，不调用第三方翻译服务。

百度密钥仅在 mini 的私有配置文件保存（权限 600），网页 API 不回显；数据库和配置不上传 GitHub。服务仅供可信家庭局域网使用，没有公网鉴权，不要把端口映射到公网。详见 [服务源码与部署说明](usage-service/README.md)。

每篇文章先进行最多1.2秒的健康检查，再给后端文章请求最多34秒；健康检查、后端请求或结果异常时使用设备端 Google 最终备用。Google 按约1200字符打包、最多三路并发，每次最多7秒，备用总预算18秒；整篇预算55秒、模块超时60秒。优先保留后端已成功的段落，仅补齐缺失段落。全部失败的内容保留原文；修改后的响应移除旧压缩、长度、ETag 等字段并设置 no-store，重复拉取则由后端缓存消除翻译消耗。

## 验证

```sh
node --check Bloomberg/bloomberg.backend.js
node --test Bloomberg/tests/*.test.cjs
python3 -m unittest discover -s Bloomberg/usage-service/tests -v
```

`bloomberg.response.js` 及其测试保留为旧版兼容实现；当前模块使用 `bloomberg.backend.js`。

平均耗时按 provider 分别提供本月与累计值，仅计算有耗时记录的成功调用，并展示有效样本数；缓存命中和无耗时的历史记录不计入均值。每千字符耗时按成功样本总耗时 / 总字符数加权计算。新后端使用实际引擎调用耗时；仍使用旧脚本的新请求以预约到完成的时间估算，包含少量局域网记账往返。

设备直连 Google 时，仅发送待译标题和正文，不附带 Bloomberg 登录凭证、来源 URL 或百度凭证。第一段明确标注“Google（设备直连备用）”与失败原因。该备用部分的用量、耗时和译文不会回传 mini，不会出现在中央统计/存档中；不在设备持久化待同步队列。后端超时后自身工作可能仍在完成，不能把设备直连译文误记成后端的结果。

2026-10-31 HAR 确认 App 使用 v2 文章详情，且正文改为 structuredData.data。只扩展 URL 匹配无法兼容，因此模块同时适配读取、回填、提示和广告配置字段。v2 的 adTargeting / adsDisabled 对应 v1 的 adParams / disableAds；不修改 metered、premium 等访问控制字段。
