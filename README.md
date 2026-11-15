# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/hoddlr/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/hoddlr/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server that answers OpenAI- and Anthropic-shaped completion requests
with real completions from OpenRouter's fourteen free models, dialled
through the grader's gateway.

## Run it

```sh
node main.ts
```

The trial sets `MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE`, `OPENAI_BASE_URL`
and `OPENAI_API_KEY`. The server registers its port and catalog with the
env, serves `POST /v1/chat/completions`, `POST /v1/messages` and
`GET /v1/models` (JSON and streaming), then exits 0 when the env's work
is done. `node main.ts --list` prints the catalog document.

## How it routes

Each prompt is matched against the brief's free model list: only models
whose capabilities meet the prompt (tools, vision, JSON mode, context)
are candidates, ranked by the house's published rating, best first. A
refused model is cooled down for the rest of the trial and the next
candidate serves instead; refusals that were recovered from are reported
on the response in `x-makefun-upstream-failures`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
