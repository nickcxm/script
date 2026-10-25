"use strict";
const $ = (id) => document.getElementById(id);
const fmt = (value) => Number(value || 0).toLocaleString("zh-CN");
const provider = (name) => (name === "baidu" ? "百度" : "Google");
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
    td.colSpan = 6;
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
    if (!$("month").value) $("month").value = data.month;
    const sum = (key) =>
      data.monthly.reduce((a, row) => a + Number(row[key] || 0), 0);
    $("summary").replaceChildren();
    for (const [title, value, detail, featured] of [
      ["本月放行字符", sum("characters"), "包含成功、失败及待回报", true],
      ["本月放行次数", sum("calls"), "每个翻译批次计一次"],
      [
        "百度放行字符",
        data.monthly.find((x) => x.provider === "baidu")?.characters || 0,
        "历史补录另计入额度",
      ],
      [
        "Google 放行字符",
        data.monthly.find((x) => x.provider === "google")?.characters || 0,
        "含百度失败后的备用请求",
      ],
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
      data.totals.map((r) => [
        provider(r.provider),
        fmt(r.calls),
        fmt(r.characters),
        fmt(r.success_characters),
        fmt(r.failed),
        fmt(r.blocked),
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
load();
setInterval(load, 10000);
