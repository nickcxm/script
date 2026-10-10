# 百度地图精简实验版 — Surge

目标是尽量减少首页推荐、Agent、金币商城和生活服务，保留搜索、路线、导航相关功能。基于用户提供的两份真实 HAR，当前实现仅过滤**组件配置/更新清单**，还不能证明已实现“只剩搜索、路线、导航”的界面。

## 安装

```text
https://raw.githubusercontent.com/nickcxm/script/main/BaiduMap/BaiduMap.Minimal.sgmodule
```

在 Surge 添加模块，启用 MITM 并信任证书，完全退出并重新打开百度地图。测试时只启用一份匹配这些接口的修改模块。

已有内置或缓存组件可能继续显示。模块不主动卸载组件、删除本地数据或清理 App 缓存；不建议为了测试先卸载 App。

## 当前处理范围

1. `POST https://mbd.baidu.com/ccs/v1/start/confsync`，仅 `appname=bdmap`：
   - 删除 `data.service.dpm.talos.mainentrance` 中的 `bdmap.mapclient.feed` 更新入口。
   - 删除 `dependencies` 中明确的 `bdmap.mapclient.feed__CLOTHOPROD__HomeFeed`。
   - 保留所有其他依赖，包括共享框架与整个 `bdmap.pubTravel.rtBus` 子树，不修改包控制值、签名或校验字段。
2. `GET https://newclient.map.baidu.com/client/imap/dl/s/UpdateInfo.php`，仅 `qt=upv&cate=components`：
   - 按下面的明确名称删除非核心包更新项；不是保留白名单，未来未知包仍放行。

| 参数 | 默认 | 对应过滤项 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭时原响应放行 |
| `hide_feed` | `true` | HomeFeed、新首页附近、周边、笔记微详情等 |
| `hide_ai` | `true` | 地图新 Agent、小度想想 |
| `hide_local_services` | `true` | 美食、酒店、首页订酒店、电影、景点专用组件 |
| `hide_gold_mall` | `true` | 金币商城 |
| `debug` | `false` | 仅输出过滤项名称、数量和版本 |

更新清单中共过滤 13 个已观察到的包：

```text
aihomenearbycontent, commicroDetail, nearbycontent, nearbybraavos, surround,
agent, mapAgent, cater, hotel, hotelChanel, movie, scenery, goldMall
```

样本中保留的 6 个包：

```text
searchList, startPage, comdetailtmpl, indoordetail, usersystem, websdk
```

它们分别涉及搜索列表、搜索起始页、通用地点详情、室内楼层、用户体系和 Web 框架。公交线路、步行/骑行与导航相关依赖在另一份配置中完整保留。

## 实际效果边界

更新清单过滤可能减少包下载/更新，不一定隐藏 UI。App 可能已有本地包、内置版本或回退路径；也可能在缺少专用组件时打开页面失败。例如搜索仍可返回酒店/景点，但对应专用详情或预订页面不保证可用。

如果首页变化不明显，需要继续捕获首页实际内容/入口配置接口，而不是扩大拦截整个更新域名。本模块没有新增对未观察接口的拒绝规则。

若发现异常：先关闭模块并重新启动 App；或逐项将 `hide_*` 设为 false，缩小影响范围。关闭模块后未来网络响应恢复放行，但 App 是否已缓存先前状态、何时再次更新由 App 自己决定。

## 数据与网络

- 仅在本地解析和修改响应 JSON，无主动网络请求、存储或动态加载。
- 只解密模块追加的 `mbd.baidu.com` 与 `newclient.map.baidu.com`；在运行时进一步校验 App 参数、请求方法、响应类型和成功状态。
- 不读取请求 Cookie、请求正文、设备标识或定位参数；日志不输出完整 URL、响应正文或凭证。
- 真实 HAR/PCAP 不上传。源码和测试只使用合成数据与公开的组件名称。
- 结构不符、非 JSON、非 200、解析异常直接放行。处理体积上限 1 MiB。
- 修改后移除旧长度、压缩和 ETag 等字段，设置 `Cache-Control: no-store`。这不保证 App 不保存自己的组件状态。

## 验证

2026-10-10：10 项自动测试通过，覆盖精确过滤清单、功能组开关、搜索/公共交通/共享依赖保留、未知字段保留、幂等、路由隔离、异常放行、凭证隔离和模块参数格式。

对用户提供的 HAR 验证：

- 更新清单：19 个包变为 6 个；保留包内容逐项深度比较一致。
- Talos 配置：入口由 2 个变为 1 个，依赖由 35 个变为 34 个。
- 公交/步行/骑行主入口和其他所有依赖保持不变。
- 尚未在真实 iOS App 中验证入口隐藏、搜索、地点详情或导航是否受影响。

```sh
node --check BaiduMap/baidumap.response.js
node --test BaiduMap/tests/minimal.test.cjs
```
