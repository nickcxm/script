"use strict";
const $ = (id) => document.getElementById(id);
const fmt = (value) => Number(value || 0).toLocaleString("zh-CN");
const duration = (value) =>
  value == null
    ? "—"
    : value >= 1000
      ? (value / 1000).toFixed(2) + " s"
      : Math.round(value) + " ms";
const provider = (name) =>
  ({ apple: "Apple 本机", baidu: "百度", google: "Google", mixed: "混合" })[
    name
  ] || name;
const states = {
  reserved: "已放行 · 待回报",
  success: "成功",
  failed: "失败",
  blocked: "额度拦截",
};
let offset = 0,
  busy = false;
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function fillTable(id, rows) {
  const body = $(id);
  body.replaceChildren();
  if (!rows.length) {
    const tr = node("tr"),
      td = node("td", "暂无记录", "empty");
    td.colSpan = body.closest("table").querySelectorAll("thead th").length;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const values of rows) {
    const tr = node("tr");
    for (const value of values) {
      const td = node("td");
      if (value instanceof Node) td.append(value);
      else td.textContent = String(value);
      tr.append(td);
    }
    body.append(tr);
  }
}
async function load() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch(
      "/api/stats?" + new URLSearchParams({ month: $("month").value, offset }),
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const archive = await loadArticles();
    if (!$("month").value) $("month").value = data.month;
    const sum = (key) =>
      data.monthly.reduce((a, row) => a + Number(row[key] || 0), 0);
    $("summary").replaceChildren();
    for (const [title, value, detail, featured] of [
      ["本月放行字符", sum("characters"), "包含成功、失败及待回报", true],
      ["本月放行次数", sum("calls"), "每个翻译批次计一次"],
      [
        "Apple 本机字符",
        data.monthly.find((x) => x.provider === "apple")?.characters || 0,
        "本机翻译，不消耗外部 API 额度",
      ],
      ["累计缓存命中", archive.cache_hits, "跨设备复用，不重复请求翻译引擎"],
    ]) {
      const card = node(
        "div",
        undefined,
        "card" + (featured ? " featured" : ""),
      );
      card.append(
        node("span", title),
        node("strong", fmt(value)),
        node("span", detail),
      );
      $("summary").append(card);
    }
    $("quotas").replaceChildren();
    if (!data.quotas.length)
      $("quotas").append(node("p", "暂无百度 APP ID；首次申请时自动登记。"));
    for (const q of data.quotas) {
      const div = node("div", undefined, "quota"),
        bar = node("progress");
      bar.max = data.limit;
      bar.value = q.opening + q.used;
      bar.setAttribute("aria-label", q.appid + " 已占用额度");
      div.append(
        node("strong", q.appid),
        node(
          "p",
          `剩余 ${fmt(q.remaining)} / ${fmt(data.limit)} · 本服务占用 ${fmt(q.used)} · 历史补录 ${fmt(q.opening)}`,
        ),
        bar,
      );
      $("quotas").append(div);
    }
    fillTable(
      "totals",
      ["apple", "baidu", "google"]
        .map(
          (name) =>
            data.totals.find((row) => row.provider === name) || {
              provider: name,
            },
        )
        .map((r) => [
          provider(r.provider),
          fmt(r.calls),
          fmt(r.characters),
          fmt(r.success_characters),
          fmt(r.failed),
          fmt(r.blocked),
          duration(
            data.monthly.find((row) => row.provider === r.provider)
              ?.avg_elapsed_ms,
          ) +
            " / " +
            fmt(
              data.monthly.find((row) => row.provider === r.provider)
                ?.timed_calls,
            ),
          duration(r.avg_elapsed_ms) + " / " + fmt(r.timed_calls),
          duration(r.ms_per_1000_characters),
        ]),
    );
    fillTable(
      "daily",
      data.daily.map((r) => [
        r.day,
        provider(r.provider),
        fmt(r.calls),
        fmt(r.characters),
      ]),
    );
    fillTable(
      "records",
      data.records.map((r) => [
        r.created_at.replace("T", " ").replace("+08:00", ""),
        provider(r.provider),
        r.appid || "—",
        fmt(r.characters),
        node("span", states[r.state] || r.state, "badge " + r.state),
        r.error || "—",
        r.elapsed_ms ? `${r.elapsed_ms} ms` : "—",
        r.article_key ? articleButton(r.article_key, "查看") : "—",
      ]),
    );
    $("count").textContent = fmt(data.record_count) + " 条记录";
    $("page").textContent =
      `${Math.floor(offset / 100) + 1} / ${Math.max(1, Math.ceil(data.record_count / 100))}`;
    $("prev").disabled = offset === 0;
    $("next").disabled = offset + 100 >= data.record_count;
    $("opening").textContent =
      `${data.initial_exhausted_month} 首次登记的百度账号按此前已用完处理，历史补录 1,000,000 字符；后续月份起始占用为 0。`;
    $("connection").textContent =
      "已连接 · " + new Date().toLocaleTimeString("zh-CN") + " 更新";
    $("connection").className = "";
  } catch (error) {
    $("connection").textContent =
      "连接失败，当前展示可能已过期：" + error.message;
    $("connection").className = "error";
  } finally {
    busy = false;
  }
}
// The service supplies its Beijing month; do not infer it from a roaming device clock.
$("refresh").addEventListener("click", load);
$("month").addEventListener("change", () => {
  offset = 0;
  load();
});
$("prev").addEventListener("click", () => {
  offset = Math.max(0, offset - 100);
  load();
});
$("next").addEventListener("click", () => {
  offset += 100;
  load();
});
let articleOffset = 0,
  settingsLoaded = false,
  lastArticleButton;
function articleButton(key, label) {
  const button = node("button", label);
  button.addEventListener("click", () => {
    lastArticleButton = button;
    showArticle(key);
  });
  return button;
}
async function loadArticles() {
  const response = await fetch("/api/articles?offset=" + articleOffset, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("文章列表 HTTP " + response.status);
  const data = await response.json();
  fillTable(
    "articles",
    data.articles.map((row) => {
      const title = node("div", undefined, "article-label");
      title.append(node("strong", row.title_translation || row.title));
      if (row.title_translation) title.append(node("small", row.title));
      return [
        title,
        fmt(row.source_characters),
        row.status === "complete"
          ? "已翻译"
          : row.status === "partial"
            ? "部分翻译"
            : "处理中",
        fmt(row.cache_hits),
        row.last_seen.replace("T", " ").slice(0, 19),
        articleButton(row.key, "中英对照"),
      ];
    }),
  );
  $("article-count").textContent = fmt(data.total) + " 个文章版本";
  $("article-page").textContent =
    `${Math.floor(articleOffset / 30) + 1} / ${Math.max(1, Math.ceil(data.total / 30))}`;
  $("article-prev").disabled = articleOffset === 0;
  $("article-next").disabled = articleOffset + 30 >= data.total;
  return data;
}
async function showArticle(key) {
  try {
    const response = await fetch("/api/articles/" + key, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    $("article-title").textContent =
      (data.title_translation ? data.title_translation + "\n" : "") +
      data.title;
    $("article-source").href = data.source_url;
    const result = data.result;
    $("article-meta").textContent =
      `源字符 ${fmt(data.source_characters)} · 缓存命中 ${fmt(data.cache_hits)} · ${(result.providers || []).map(provider).join("、")}`;
    $("article-body").replaceChildren();
    for (const item of data.source.paragraphs) {
      $("article-body").append(
        node("p", item.id + ". " + item.text, "source-text"),
      );
      for (const piece of result.translations || []) {
        const bodyIds = piece.ids.filter((id) => id > 0);
        if (bodyIds.length && Math.max(...bodyIds) === item.id)
          $("article-body").append(
            node(
              "p",
              piece.ids.map((id) => id + ".").join(" ") + " " + piece.text,
              "translated-text",
            ),
          );
      }
    }
    if ((result.warnings || []).length)
      $("article-body").append(node("p", result.warnings.join(" "), "error"));
    $("article-view").hidden = false;
    $("article-view").scrollIntoView({ block: "start" });
  } catch (error) {
    $("connection").textContent = "无法打开文章：" + error.message;
  }
}
async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    $("apple-status").textContent = data.apple.ok
      ? "Apple 英中语言包已就绪"
      : "Apple 尚未就绪：" + (data.apple.message || data.apple.code);
    if (!settingsLoaded) {
      $("provider").value = data.provider;
      $("baidu-appid").value = data.baidu_appid;
      settingsLoaded = true;
    }
    $("baidu-key").placeholder = data.baidu_key_configured
      ? "已有密钥，留空保持不变"
      : "尚未配置百度密钥";
  } catch (error) {
    $("apple-status").textContent = "语言包检测失败：" + error.message;
  }
}
$("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("settings-status").textContent = "正在保存…";
  try {
    const body = {
      provider: $("provider").value,
      baidu_appid: $("baidu-appid").value.trim(),
      baidu_key: $("baidu-key").value.trim(),
      clear_baidu_key: $("clear-key").checked,
    };
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    $("baidu-key").value = "";
    $("clear-key").checked = false;
    $("settings-status").textContent = "已保存，下一次翻译生效。";
    await loadConfig();
  } catch (error) {
    $("settings-status").textContent = "保存失败：" + error.message;
  }
});
$("check-apple").addEventListener("click", loadConfig);
$("article-prev").addEventListener("click", () => {
  articleOffset = Math.max(0, articleOffset - 30);
  load();
});
$("article-next").addEventListener("click", () => {
  articleOffset += 30;
  load();
});
$("close-article").addEventListener("click", () => {
  $("article-view").hidden = true;
  if (lastArticleButton?.isConnected) lastArticleButton.focus();
});
loadConfig();
load();
setInterval(load, 10000);
