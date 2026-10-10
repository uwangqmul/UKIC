# UKIC Hub：UMushroom 比赛看板

把原来的两个项目放在一起，再加一层看板、时间表和推理流水线。

```
UKIC (this repo)\
├─ (repo root)  原 Nick_fixed\UKIC_Nick_fixed（Node）：UMushroom 买卖、订单锁、组合日志页 :6420
├─ news_bot\    原 Stocks_bot（Python）：资讯采集、Jev 判断、Telegram 推送、K 线看板
├─ hub\         新增：看板 :6400、时间表、推理流水线、Skill 和提示词
│  ├─ server.py       看板服务（只在本机 127.0.0.1 监听）
│  ├─ scheduler.py    时间表（伦敦时间，自动处理冬令时）
│  ├─ pipeline.py     资讯包 → Jev 概率 → 买/卖/持有建议 → Telegram
│  ├─ common.py       路径、设置、时区
│  ├─ skill\          SKILL.md（Nick 的五点结构）和定时会话提示词
│  ├─ web\            看板页面
│  └─ data\           assets.json（板块、是否交易、时效规则）、settings.json、briefs\、decisions\、hub.log
├─ start_hub.bat              唯一入口：第一次自动搬入两个旧文件夹并修好路径，之后每次启动新闻机器人 + 看板 + 时间表
└─ install_autostart_hub.bat  可选：开机自动启动（remove_autostart_hub.bat 取消）
```

## 第一次

1. 关掉 Stock News Bot 的黑色窗口、项目打开的 Chrome，以及打开这两个文件夹的 VS Code / PyCharm。
2. 双击 `start_hub.bat`。第一次运行时它会先：
   - 把 `..\Nick_fixed\UKIC_Nick_fixed` 移成 `trader`，把 `..\Stocks_bot` 移成 `news_bot`（git 历史、UMushroom 登录、alerts.db、日志都跟着走）
   - 删掉指向旧 Stocks_bot 的开机启动项
   - 把 `trader\mcp.json` 里的旧路径改成新路径
   - `With_Nick` 不动
3. 然后自动启动，浏览器会打开 http://127.0.0.1:6400/。以后每天也只双击这一个文件。

其他路径不用改：news_bot 的 `.py` 和 `.bat` 本来就用相对路径，trader 的 `src\config.js` 也是。
如果你在 Claude Desktop 等客户端里配置过 UMushroom MCP 服务器，那里的路径要改成 `...\UKIC_Hub\trader\src\server.js`。

## 时间表（默认：欧股 + 美股）

| 时间（伦敦） | 做什么 |
|---|---|
| 00:00、03:00 | 只收集资讯，生成资讯包，不推理 |
| 06:00 | 早盘推理，结果发 Telegram（7 点前就有） |
| 08:55 | 提醒：欧股时段开始 |
| 09:00 到美股收盘前 30 分钟，每 30 分钟 | 盘中推理；有买卖建议才发 Telegram |
| 美股开盘前 5 分钟 | 提醒：打开 UMushroom 下单 |

冬令时自动处理：英国 10 月 25 日、美国 11 月 1 日回到冬令时，这一周美股为伦敦时间 13:30–20:00，窗口自动变成 09:00–19:30，看板顶部会提示。全部可在"时间表"里改（只美股、60 分钟间隔、阈值等）。

## 推理怎么做（Nick 的五点）

1. 用途：只服务 UMushroom 比赛，整理资讯给 Jev。
2. 资产和板块：`hub\data\assets.json` 里勾选"交易"的资产；每条资讯按关键词分成"即时"（几小时内）和"滞后"（12–24 小时）。
3. 格式：每个资产给 Jev 最多 8 条标题，并标明时间、时效和类型。
4. 自动喂给 Jev：问 "price rise / price down / no clear move" 的概率，分"未来几小时"和"12–24 小时"两个时效。
5. 应用结果：上涨概率 ≥ 60% 且比下跌高 15 个百分点 → BUY；反之 → SELL；否则 HOLD。结果写到 `hub\data\decisions\`，并发到 Telegram。

没有 Jev Key 时，会改用 news_bot 已经存好的单条判断取平均，看板上会标明"文章平均"。

## 下单

以手动为主。在"交易建议"里点"去下单"，先点"预览"（Chrome 会填好表单，但不提交），确认后再点"确认提交订单"。

### 自动下单（默认关闭）

在"下单"页底部，分三档：关闭 / 演练 / 实盘。代码在 `hub/autotrade.py`，调用 trader 的方式在 `hub/trader_bridge.py`。

- **演练**：每次推理后，对符合条件的建议打开 UMushroom，在比赛组合里把订单填好，但不提交。用来验证比赛页面的按钮逻辑。
- **实盘**：同样流程，但会提交订单。开启前必须满足两条：填了比赛组合名称；同一组合 7 天内有过一次成功的演练（点"演练一次"即可）。切换时还要输入 LIVE 确认。
- **限额**（都可在页面上改）：Jev 概率 ≥ 70%；每笔买入 10,000 美元；卖出只卖已持有的股票（看 trader 组合日志）；每轮最多 2 笔，每天最多 6 笔；同一只股票 24 小时内只下一单；只做美股代码；只在早盘和盘中推理后下单。
- **安全**：实盘下单如果失败（页面和预期不符），自动退回演练档。每笔记录在 `hub/data/auto_trades.jsonl`，结果发到 Telegram，看板上也能看到。
- 自动下单要用项目自己的 Chrome，运行时请关掉项目打开的 UMushroom 窗口。

## Claude 定时任务

`hub\skill\scheduled_prompt.md` 是给 Claude 定时任务用的提示词。Claude 读取最新的资讯包和 Jev 结果，复核后写出 `<id>-claude.json`，看板会一起显示。看板本身不依赖它，没跑的时候照常能用。
