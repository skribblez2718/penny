---
description: Clean all state, research, plan, and memory files
---

Delete all orchestration state files, research files, plan files, and memory files with a single command.

Execute this cleanup:

```bash
# Clear orchestration state files
find .claude/orchestration -path "*/state/*.json" -type f -delete
echo "State cleanup complete"

# Clear research files (preserve .gitkeep)
find .claude/research -type f ! -name '.gitkeep' -delete
echo "Research cleanup complete"

# Clear plans files (preserve .gitkeep)
find .claude/plans -type f ! -name '.gitkeep' -delete
find .claude/plans -mindepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
echo "Plans cleanup complete"

# Clear memory files (preserve .gitkeep)
find .claude/memory -type f ! -name '.gitkeep' -delete
echo "Memory cleanup complete"

echo ""
echo "All cleanup complete!"
```
