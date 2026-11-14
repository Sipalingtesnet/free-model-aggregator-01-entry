# Free Model Aggregator Entry

An intelligent, resilient multi-provider free model aggregator supporting OpenAI (`/v1/chat/completions`), Anthropic (`/v1/messages`), and Gemini (`/v1beta/models`) upstream wires.

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
