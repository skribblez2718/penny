---
description: Clean all research files
---

Delete all research files from the .claude/research directory.

Execute this cleanup:

```bash
# Remove all files from research directory (preserve .gitkeep)
find .claude/research -type f ! -name '.gitkeep' -delete

echo "Research cleanup complete"
```
