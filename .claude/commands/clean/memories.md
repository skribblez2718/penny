---
description: Clean all memory files
---

Delete all memory files from the .claude/memory directory.

Execute this cleanup:

```bash
# Remove all markdown files from memory directory (preserve .gitkeep)
find .claude/memory -type f ! -name '.gitkeep' -delete

echo "Memory cleanup complete"
```
