---
name: session-stats
description: View live session statistics, token usage, cache hit rate, execution timings, and context window gauge in the Auxiliary (Side) Pane. Use when the user asks about token consumption, LLM/tool latency, context capacity, or session resource usage.
---

# Session Statistics Skill

This skill allows the user to open and inspect the real-time Session Statistics & Token Usage dashboard in Antigravity 2.0's Auxiliary (Side) Pane.

## How to Surface the Sidecar Dashboard

When the user asks about session performance, token usage, or context size, provide a direct one-click navigation pill in your response:

```markdown
[📊 Open Session Statistics](sidecar://session-stats/viewer/ui.html)
```

Clicking this link toggles the interactive sidecar web panel in the Antigravity 2.0 Auxiliary (Side) Pane.

## What the Dashboard Displays

1. **Session Statistics**: Cumulative LLM response time, tool execution duration, turn count, and token generation rate (TPS).
2. **Token Usage**: Total token count, cache hit %, uncached input, cached input, and output tokens.
3. **Context Utilization**: Active conversation context size versus the 1M token capacity, with breakdowns for system prompt, tool definitions, and message history.
