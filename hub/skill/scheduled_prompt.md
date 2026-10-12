# Prompt for the Claude scheduled task (Cowork)

Paste this into a Claude scheduled task that has the `UKIC_Hub` folder (this repo) connected.
Suggested schedule (London time): 06:00 every weekday, and every 30 minutes from 09:00 to 20:30 on weekdays.
Note: on 25 Oct-1 Nov 2026 the US market is 13:30-20:00 London time, so end at 19:30 that week.

---

You are helping team UKIC with the UMushroom investment competition. Follow the skill in `hub/skill/SKILL.md`.

1. If you can run commands, run `python hub/pipeline.py intraday` from the `UKIC_Hub` folder and wait for it to finish (about a minute). If you cannot run commands, skip this step: the hub runs it on its own schedule.
2. Open the newest file in `hub/data/briefs/` (`.md`) and the newest file in `hub/data/decisions/` (`.json`, not ending in `-claude.json`). If its `engine` is "article-average", Jev was not reached: trust the probabilities less.
3. For every asset with news, check Jev's probabilities against the headlines (SKILL.md section 5):
   - Is the news really about this asset, and is it new (not a move that already happened)?
   - Is the source official, or does it still need confirming?
   - Is it immediate (hours) or delayed (12-24 hours)?
   - Does group-wide news (export rules, defence budgets, rates) affect other assets we hold?
4. Check every BUY/SELL you keep against the portfolio rules (SKILL.md section 6): at most 6% per asset and 20% per group, hedges at least 15%, never borrow. We hold almost no cash, so pair each BUY with the SELL or trim that pays for it.
5. Write `hub/data/decisions/<same id>-claude.json` with the same structure as the decision file
   (`id`, `kind`, `london`, `brief`, `engine` = "claude", `rows`: symbol, name, sector, action BUY/SELL/HOLD,
   horizon "hours" or "day", prob, strength, probs, source = "claude", news, top), changing only the rows you disagree with,
   and add a `why` field to each BUY/SELL row in one sentence (headline, source, size, what funds it).
6. If you changed at least one row and can run commands, send it with `python hub/pipeline.py telegram hub/data/decisions/<id>-claude.json`. The pipeline has already sent its own suggestions, so do not send an unchanged copy.
7. For each BUY/SELL you recommend, draft a plain-text strategy-log entry in the format of SKILL.md section 8 and save the drafts to `hub/data/decisions/<same id>-log.txt`, for the team to add to the log and post on UMushroom once the order is placed.
8. Do not place any orders. The team places them by hand.
