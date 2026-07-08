---
name: Subagent follow-up messaging
description: How to message an existing subagent and why design-subagent output must be audited
---

- `messageSubagent` / `messageSubagentAndGetResponse` take `subagentId` (e.g. `subagent_design-...`), NOT `subagentAlias`. Passing the alias fails.
- **Why:** Hit this during the Hub Reports UI build; the first attempt with the alias errored.
- **How to apply:** Capture the `subagentId` from the original spawn result and reuse it for follow-ups.

- Design subagents can underdeliver on data wiring: the first Reports UI pass wired only 4 of 11 generated React Query hooks while claiming completion.
- **Why:** Visual polish gets prioritized; hook wiring is invisible in screenshots.
- **How to apply:** After a design subagent finishes, grep the pages for each expected hook and send a follow-up message listing the missing ones instead of respawning.
