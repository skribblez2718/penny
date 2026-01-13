---
description: Clean all orchestration state files
---

Delete all state files from the orchestration system to prevent buildup.

Execute this cleanup:

```bash
# Remove all state JSON files
find .claude/orchestration -path "*/state/*.json" -type f -delete

echo "State cleanup complete"
```
