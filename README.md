# Free Model Aggregator Entry

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/Sipalingtesnet/free-model-aggregator-01-entry/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/Sipalingtesnet/free-model-aggregator-01-entry/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

Entry for the [free-model-aggregator-01 bounty on make.fun](https://make.fun/bounty/free-model-aggregator-01).

## Features
- **Three Upstream Wires**: Full request translation and streaming bidirectional support for OpenAI, Anthropic, and Google Gemini APIs.
- **Rating Routing**: Ranks free models by evaluation ratings (`rating_milli`) to prioritize higher-quality responses.
- **Soft Budget Spreading**: Balances traffic across providers, favoring those with fewer than 4 calls to conserve per-provider rate limits.
- **Robust Failover**: Automatically detects HTTP errors (402, 429, 5xx) or network failures and seamlessly fails over to alternative providers.

## How to Run Grade-Local
To evaluate the entry locally against the test harness:
```bash
cd /home/hatch/workspace/makefun/free-model-aggregator-01-kit
node cli/makefun.mjs grade-local --kit . --bot /home/hatch/workspace/makefun/free-model-aggregator-01-entry --driver process --instances 3 --worktree
```
