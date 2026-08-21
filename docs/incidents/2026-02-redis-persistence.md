# ISSUE: Redis Data Persistence (RESOLVED)

## Original Problem
If a tool is enabled for a chat and services are subsequently restarted, the enabled tools/skills information was lost from Redis.

## Root Cause
Redis was configured without persistence:
- No volume mount for data storage
- No AOF (append-only file) or RDB snapshot configuration
- `allkeys-lru` eviction policy could evict any key under memory pressure

## Solution
Updated `docker-compose.yml` Redis configuration:

```yaml
redis:
  image: redis:7-alpine
  volumes:
    - redis-data:/data  # Persist data to Docker volume
  command: redis-server --maxmemory 128mb --maxmemory-policy volatile-lru --appendonly yes --appendfsync everysec --save 60 1
```

Changes made:
1. **Added volume mount** (`redis-data:/data`) - Data persists across container restarts
2. **Enabled AOF persistence** (`--appendonly yes`) - Every write is logged to disk
3. **Set fsync policy** (`--appendfsync everysec`) - Sync to disk every second (balance of durability and performance)
4. **Enabled RDB snapshots** (`--save 60 1`) - Save snapshot every 60 seconds if at least 1 key changed
5. **Changed eviction policy** (`volatile-lru`) - Only evict keys with TTL set, preserving permanent data like chat capabilities

## Verification
After restarting containers, chat capabilities (tools/skills badges) should persist and display correctly when reopening old chats.
