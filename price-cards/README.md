# Versioned price cards

Price cards are explicit experimental inputs, not evergreen constants. Each
card identifies its source, retrieval date, service tier, context tier,
regional-processing assumption, and exclusions.

Raw provider token counts remain authoritative. USD values are derived for the
declared card only and must be recomputed whenever model pricing, context
routing, service tier, region, or tool usage changes.

Validate the included card without reading a credential or making an API call:

```bash
node agent-wind-tunnel.mjs validate \
  --price-card price-cards/openai-standard-short-context-2026-07-28.json
```
