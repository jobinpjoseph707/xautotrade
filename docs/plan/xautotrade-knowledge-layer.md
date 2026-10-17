# XAutoTrade — knowledge layer (Phase 3, task 3.4)

Goes with `PLAN-3-PHASES.md` (3.4) and tests K-1 to K-8 in `TEST-PLAN.md`.

## What it is

A small graph of **ideas** that the agents may read as context, stored in two ordinary tables (`kg_nodes`, `kg_edges`) in the same SQLite file. No graph database (Kùzu was archived in October 2025).

| Node | Comes from | What is stored |
|---|---|---|
| `idea` | a YouTube strategy you sent to the Inbox, or a competition method you typed in | title, source, symbol, one or two sentences of entry idea. Never position sizing. |
| `concept` | a book chapter you pasted | a note of at most 160 characters in the model's own words, the book, the page. Never the text. |
| `strategy` | the strategy a video idea was built into | its id and name, so outcomes can be tied back to the idea |

Links carry `valid_from` and `valid_until`. A link that turns out wrong is **closed with a reason**, never deleted (K-2).

## The rules

- **Status is measured, nothing else.** An idea is `untested`, `supported by N outcomes` or `contradicted by N outcomes`. It counts only approved, scored changes on strategies built from the idea through a link that still holds. One helped change is "supported by 1". Two hurt and more hurt than helped is "contradicted". Anything mixed stays untested. Who said it, how popular the video was and what a book says do not matter (K-6).
- **A book can never change a lesson's score** (K-7). `learning/` does not import `knowledge/`, and a test fails the build if it ever does.
- **Book text is not kept** (K-5). The pasted chapter goes to the model once. Each returned note is cut to 160 characters, at most 5 per paste, and dropped if it repeats 40 or more characters in a row from the paste. The chapter is not written anywhere.
- **Sizing is thrown away** (K-3). A video's "I risk 2% per trade" is ignored and the strategy keeps your risk settings (0.01 lot, tier caps). Competition sizing is never read.
- **An idea from a video is not permission** (K-4). `EligibleStrategy`, the synthetic-candle gate, `GateFailedError` and `defaultGateData` are deleted. What is left in `youtube/gate.ts` is a backtest check on real broker candles. Moving up a stage is decided by the Phase 2 gates. A video strategy is still only a proposal in the Inbox at the first stage (`backtest`), and nothing is saved until you tap Approve.
- **At most 5 knowledge lines reach a prompt** (K-8), each at most 260 characters, ideas on the same market first, then book notes labelled "not evidence". The prompt section appears only when there is something to show.

## Where it shows

- Strategies > **Ideas**: the ideas with their status, book notes, a form to paste a chapter, a form to add a competition method.
- Agents' prompts: an "IDEAS AND BOOK NOTES" section.
- API: `GET /api/knowledge`, `POST /api/knowledge/books`, `POST /api/knowledge/competition` (owner key; the agent key is refused, AG-10).

## What is not done, on purpose or not yet

- The **Strategist route** for YouTube (`/api/youtube/strategist`) makes proposals through the chat, and those are **not** recorded as ideas yet. Only the "Analyse then Send to Inbox" path records one.
- Nothing closes a link by itself when an idea becomes "contradicted". It is shown, and `KnowledgeGraph.contradict` exists, but no screen calls it.
- Book notes are made by one model call (`CHAT_ROUTER_MODEL`, default `haiku`) and have **never run with the real Claude**; tests use a fake summariser. Quality of the notes is unknown.
- Idea relevance is by symbol only. Book notes are not matched to a market at all, so the newest few appear.
- Status needs scored outcomes (30 demo trades each), so for the first weeks every idea will read "untested". That is correct, not a bug.
