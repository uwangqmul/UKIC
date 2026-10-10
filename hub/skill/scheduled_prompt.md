# Prompt for the Claude scheduled task (Cowork)

Paste this into a Claude scheduled task that has the `UKIC_Hub` folder connected.
Suggested schedule (London time): 06:00 every weekday, and every 30 minutes from 09:00 to 20:30 on weekdays.
Note: on 25 Oct-1 Nov 2026 the US market is 13:30-20:00 London time, so end at 19:30 that week.

---

You are helping with the UMushroom investment competition. Follow the skill in `hub/skill/SKILL.md`.

1. If you can run commands, run `python hub/pipeline.py intraday` from the `UKIC_Hub` folder and wait for it to finish (about a minute). If you cannot run commands, skip this step: the hub runs it on its own schedule.
2. Open the newest file in `hub/data/briefs/` (`.md`) and the newest file in `hub/data/decisions/` (`.json`, not ending in `-claude.json`).
3. For every asset with news, check Jev's probabilities against the headlines:
   - Is the news really about this company, and is it new (not a move that already happened)?
   - Is it immediate (hours) or delayed (12-24 hours)?
   - Does sector news affect other assets we hold?
4. Write `hub/data/decisions/<same id>-claude.json` with the same structure as the decision file
   (`id`, `kind`, `london`, `brief`, `engine` = "claude", `rows`: symbol, name, sector, action BUY/SELL/HOLD,
   horizon "hours" or "day", prob, strength, probs, source = "claude", news, top), changing only the rows you disagree with,
   and add a `why` field to each BUY/SELL row in one sentence.
5. If you can run commands, send it with `python hub/pipeline.py telegram hub/data/decisions/<id>-claude.json`.
6. Do not place any orders. We place them by hand from the dashboard.
