---
name: web-search
description: Search the web for current information using OpenAI's web search. Use when user needs real-time web data, current events, or information beyond training data.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "2.0"
  priority: high
  triggers:
    - "search the web"
    - "web search"
    - "current information"
    - "find online"
    - "search online"
    - "latest news"
    - "current events"
    - "look up online"
    - "google"
    - "search internet"
    - "what's happening"
    - "recent news"
    - "search for"
    - "look up"
required_mcp_servers:
  - "server:web-tools"
---

# Web Search Skill

Search the web for current information, recent events, and data beyond the model's training cutoff.

## When to Use Web Search

**USE Web Search for:**
- Current events and recent news
- Real-time information (stock prices, weather, sports scores)
- Documentation for recent software versions
- Fact-checking with up-to-date sources
- Information published after the model's training cutoff
- External/public documentation and resources

**DO NOT use Web Search for:**
- Company-internal information (use company-knowledge skill/Glean instead)
- Tasks that require internal system access
- When Glean or other internal tools have the information
- Simple questions that don't require current data
- Information already in your training data

## Decision Tree

```
User Request
    |
    v
Is it about EXTERNAL/PUBLIC information?
    |
    |-- YES --> Is it time-sensitive or recent?
    |              |
    |              |-- YES --> Use web-search
    |              |-- NO --> Consider if you already know it
    |
    |-- NO --> Is it about COMPANY information?
                |
                |-- YES --> Use company-knowledge skill (Glean)
                |-- NO --> Consider other tools
```

## Available Tools

Once this skill is activated, the following tools become available:

### web_tools_web_search
Search the web for current information.

**Parameters:**
- `query` (required): Search query string
- `allowed_domains` (optional): List of domains to include (max 100)
- `blocked_domains` (optional): List of domains to exclude
- `user_location` (optional): Approximate location for geo-relevant results

## Example Usage

### Current Events
```
User: "What are the latest developments in AI regulation?"

1. Skill auto-activates (triggers: "latest")
2. Use web_tools_web_search(query="AI regulation news 2025")
3. Return results with citations
```

### Technical Documentation
```
User: "Search for the latest React 19 features"

1. Skill auto-activates (triggers: "search for")
2. Use web_tools_web_search(query="React 19 new features documentation")
3. Return findings with source links
```

### Fact Checking
```
User: "What's the current population of Tokyo?"

1. Skill auto-activates (triggers: "current")
2. Use web_tools_web_search(query="Tokyo population 2025")
3. Return verified information with sources
```

### Location-Based Search
```
User: "What are the best restaurants in Austin?"

1. Skill auto-activates (triggers: "search")
2. Use web_tools_web_search(query="best restaurants Austin", user_location={"country": "US", "city": "Austin", "region": "Texas"})
3. Return results tailored to the location
```

## Best Practices

1. **Always cite sources** - Include URLs from search results in your response
2. **Verify information** - Cross-reference multiple sources when possible
3. **Prefer internal sources** - Use Glean for company info, web search for external
4. **Be specific** - More specific queries yield better results
5. **Check dates** - Ensure sources are recent for time-sensitive queries

## Common Mistakes to Avoid

| User Request | WRONG Approach | RIGHT Approach |
|-------------|----------------|----------------|
| "Find our API auth documentation" | Use web search | Use company-knowledge skill (Glean) |
| "What's our PTO policy?" | Use web search | Use company-knowledge skill (Glean) |
| "Latest Python 3.12 features" | Use Glean | Use this skill (web search) |
| "Current stock price of AAPL" | Guess from training | Use this skill (web search) |

## Important Notes

1. **External only** - Web search is for public internet content, not internal systems
2. **Citations matter** - Always provide source URLs to users
3. **Rate limits** - Use efficiently, don't make excessive searches
4. **Privacy** - Don't search for sensitive/personal information
