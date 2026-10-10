# 股票资讯机器人（Stocks_bot）

自动收集你关注的 31 家公司的资讯（市场新闻、官方新品发布、军方/政府合同），用 Jev 判断每条资讯是利好还是利空，推送到 Telegram，并生成一个带 K 线图的本地看板。

程序在你自己的电脑上运行，电脑开机、联网、窗口开着就会每 20 分钟检查一次。

---

## 每天怎么用

**双击 `start_stock_bot.bat`**，就会：

1. 检查依赖和 Telegram 配置
2. 抓取全部资讯 → 筛选去重 → Jev 判断 → 推送到 Telegram
3. 生成看板并自动在浏览器打开
4. 之后每 20 分钟重复一次，直到你关掉这个黑色窗口

想开机自动运行：双击一次 `install_autostart.bat`，以后每次登录 Windows 都会自动在后台（最小化）启动。取消用 `remove_autostart.bat`。

只想看看板：双击 `open_dashboard.bat`（会先刷新数据再打开）。

---

## 功能说明

### 1. 资讯来源

| 来源 | 内容 | 覆盖 |
|---|---|---|
| Google News 搜索 | 市场新闻、新品发布、合同 | 每家公司 |
| Google News 合同搜索 | 军方/政府合同（Pentagon、Army、Navy、Air Force 等） | LMT、NOC、GD、PLTR、SpaceX |
| Yahoo Finance | 个股新闻 | 美股上市公司 |
| 官方新闻室 RSS | 官方新品发布、公告 | Apple、NVIDIA、Microsoft、Meta、Google、Cisco、Cloudflare、Lockheed Martin |
| 美国国防部每日合同公告 | 所有国防合同，自动截取提到该公司的段落 | 全部公司 |

全部是公开免费的 RSS，不需要账号。

### 2. 筛选与去重

- 英文关键词按**整词、区分大小写**匹配，避免误判（例如 “artificial intelligence” 不会算成 Intel，“10 micron” 不会算成 Micron）。
- 可以为公司设置排除词，例如 Corning 排除了 “Owens Corning”（另一家公司）。
- 同一条新闻多个来源重复出现只推一次；已推送的记录保存在 `alerts.db`，重启也不会重复推送。
- 只看最近 3 天内发布的资讯。

### 3. 推送规则

- 每家公司每轮最多推 5 条，官方发布和合同优先。
- 一轮超过 5 条时，合并成**按公司分组的汇总**消息，标题可直接点击打开原文。
- 新加入的公司第一次只推最新 1 条，其余记为已读，不会刷屏。
- 推送失败（比如断网）会保留，下一轮自动补发。

标签含义：🏢 Official（官方发布）　🛡️ Contract/Defense（合同/军方）　📰 News（资讯）

推送、看板和代码注释均为英文。

### 4. Jev 判断

每条要推送的资讯先交给 [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)（TypeSafe 的 System One 模型）回答三个问题：

| 问题 | 结果 |
|---|---|
| 这条新闻对股价短期可能是什么影响？ | 📈 Bullish（利好）/ 📉 Bearish（利空）/ ➖ Neutral（中性）+ 把握（%） |
| 影响有多大？ | Low / Med / High（❗ 表示高） |
| 主要是在讲这家公司吗？ | Main topic / Partly / In passing |

推送里显示为：`🤖 Jev: 📈 Bullish 81% | Impact High`；汇总里每条标题后面有 `📈81%❗` 这样的标记，公司标题后有 `📈3 📉1` 的统计。

> ⚠️ Jev 判断的是“这条新闻偏正面还是负面”，**不是涨跌预测，也不构成投资建议**。很多新闻发出时股价已经反映了，标题也常常是在描述已经发生的涨跌。看板里的命中率会告诉你它在你这些股票上实际表现如何，跑几周再下结论。

### 5. 看板（dashboard.html）

- **左侧列表**：31 家公司的最新价、涨跌、资讯数、利好/利空数；细条是近 3 天 Jev 净倾向。可按 Jev 倾向 / 涨跌 / 资讯数 / 代码排序，可搜索。
- **K 线图**：近 1 年日 K，可切 1 月 / 3 月 / 6 月 / 1 年。箭头标出有利好（下方）/ 利空（上方）资讯的日子，点某天 K 线可筛选当天资讯。
- **资讯列表**：近 14 天，可筛选利好 / 利空 / 官方 / 合同。**点开一条**可看到 Jev 的方向、影响、相关度，以及“之后一天”“至今”的实际涨跌和是否与 Jev 一致，还有“阅读原文”按钮。
- **顶部命中率**：Jev 方向判断与之后一天实际涨跌一致的比例。以新闻发布后的第一个收盘价为基准（看到新闻后最早能买入的价格），只统计涨跌超过 0.3% 的利好/利空判断。
- **涨跌颜色**：默认红涨绿跌（Red up / Green down），右上角一键切换。

行情来自 Yahoo Finance（免费）。SpaceX 未上市没有行情；Fidelity 需要告诉具体 ETF 代码。

---

## 第一次配置（已经配好的可以跳过）

### Telegram

1. 在 Telegram 找 @BotFather，发 `/newbot` 创建机器人（当前使用的是 **@wz_stock_alert_bot**）。
2. 双击 `setup_telegram.bat`，按提示粘贴 Bot Token，然后给机器人发 `/start`。
3. 程序自动读取 Chat ID、保存到 `.env`，并发送一条测试消息。

### 推送到群（和同学一起看）

当前推送到 Telegram 群 **Stock Alert 资讯群**（成员：你、Nick、Stock Alert 机器人）。

想换一个群：新建群并把 @wz_stock_alert_bot 拉进去 → 双击 `use_group.bat` → 重新启动 `start_stock_bot.bat`。想改回私聊：把 `.env` 里 `TELEGRAM_PRIVATE_CHAT_ID` 的值复制到 `TELEGRAM_CHAT_ID`。

### Jev

1. 在 <https://console.typesafe.ai/> 注册并创建 API Key。
2. 双击 `setup_jev.bat`，按提示粘贴 Key。程序会用一条测试新闻验证后保存。

没有配置 Jev 时，其他功能照常运行，只是没有利好/利空判断。

---

## 修改关注的股票

编辑 `config.json` 里的 `stocks`，每家公司一段，例如：

```json
{
  "symbol": "TSLA",
  "name": "Tesla",
  "keywords": ["Tesla", "TSLA", "Elon Musk"],
  "query": "Tesla OR TSLA",
  "official": ["https://例如官方新闻室的RSS地址"],
  "contracts": false,
  "exclude": ["不想匹配的词"]
}
```

| 字段 | 说明 |
|---|---|
| `symbol` | 股票代码，也用于取行情（韩股如 `005930.KS`） |
| `name` | 显示名称，也会告诉 Jev 这是哪家公司 |
| `keywords` | 资讯里必须出现其中之一（整词、区分大小写；中文直接包含） |
| `query` | Google News 搜索词 |
| `official` | 可选，官方新闻室 RSS 地址 |
| `contracts` | 可选，`true` 时额外搜索军方/政府合同 |
| `exclude` | 可选，标题出现这些词就排除 |
| `yahoo` | 可选，`false` 表示不用 Yahoo 个股新闻（非美股、未上市） |

其他设置：`check_interval_minutes`（检查间隔）、`max_items_per_stock_per_run`（每家每轮最多推几条）、`digest_threshold`（超过几条改为汇总）、`max_age_days`（只看几天内的资讯）。

改完保存即可，正在运行的机器人下一轮会自动读取新配置。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `start_stock_bot.bat` | **每天用这个**：一键运行全部功能并循环 |
| `app.py` | 主程序：循环执行“采集 → Jev → 推送 → 看板” |
| `news.py` | 资讯采集、筛选、去重、推送 |
| `jev.py` | Jev 判断 |
| `dashboard.py` / `dashboard_template.html` | 生成看板 |
| `telegram_bot.py` | Telegram 发送 |
| `config.json` | 关注的股票和各项设置 |
| `.env` | **Bot Token、Chat ID、Jev Key（不要发给别人）** |
| `alerts.db` | 资讯记录、推送状态、Jev 结果 |
| `stock_alert.log` | 运行日志 |
| `dashboard.html` | 生成的看板页面 |
| `run_news.bat` | 只运行一轮（采集 + 推送 + 看板） |
| `open_dashboard.bat` | 刷新并打开看板 |
| `setup_telegram.bat` / `setup_jev.bat` | 首次配置 |
| `use_group.bat` | 把推送目标改为机器人所在的 Telegram 群 |
| `install_autostart.bat` / `remove_autostart.bat` | 开机自动运行 / 取消 |

---

## 费用

- Telegram Bot、所有资讯来源、Yahoo 行情：**免费**
- Jev：每百万输入 token 0.042 美元，输出免费；每天几百条资讯不到 1 美分
- 电脑电费、网费

---

## 常见问题

**收不到 Telegram 消息**　看黑色窗口或 `stock_alert.log` 的报错。`Unauthorized` 表示 Token 错了：删除 `.env` 里 `TELEGRAM_BOT_TOKEN=` 后面的内容，重新运行 `setup_telegram.bat`。

**提示“机器人已经在运行了”**　说明已经有一个窗口在跑（可能是开机自启的最小化窗口），不需要再开。

**某个来源不可用**　日志里会显示“来源不可用”，其他来源不受影响。

**看板 K 线不显示**　图表组件和字体从网上加载，需要联网；刷新页面即可。

**消息太多**　调小 `max_items_per_stock_per_run`，或调大 `check_interval_minutes`。

**Jev 判断失败**　检查 Key 是否有效；可重新运行 `setup_jev.bat`。

---

## 安全提醒

- `.env` 里是你的 Bot Token 和 Jev Key，相当于密码，不要上传或发给别人（`.gitignore` 已经排除）。
- 如果 Key 或 Token 曾经发到聊天或别处，建议重新生成：Telegram 找 @BotFather 发 `/revoke`；Jev 在控制台删除旧 Key 再新建。然后清空 `.env` 中对应的值，重新运行对应的 setup 程序。
