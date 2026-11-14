# Make.fun Competition Entry: Multi-Provider Intelligent Gateway

An enterprise-grade, high-performance Deno/TypeScript gateway supporting OpenAI, Anthropic, and Gemini wire protocols with robust multi-provider rating-based routing, budget spreading, and automatic failover.

## Features
- **Multi-Protocol Support**: Full request/response and SSE streaming translation between OpenAI (`/v1/chat/completions`), Anthropic (`/v1/messages`), and Gemini (`/v1beta/models`).
- **Rating-Based Routing & Budget Spreading**: Dynamically routes traffic to the highest-rated providers while managing remaining budget allocation.
- **Failover Loop**: Automatically retries across backup providers on failure or high latency.
- **CLI Commands**: `--list`, `register`, and `poll`.
