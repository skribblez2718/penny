---
description: Clean all plan files
---

Delete all plan files from the .claude/plans directory.

Execute this cleanup:

```bash
# Remove all files from plans directory (preserve .gitkeep)
find .claude/plans -type f ! -name '.gitkeep' -delete
# Remove any subdirectories in plans
find .claude/plans -mindepth 1 -type d -exec rm -rf {} + 2>/dev/null || true

echo "Plans cleanup complete"
```
