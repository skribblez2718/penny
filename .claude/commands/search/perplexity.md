---
description: Search using Perplexity API with source attribution
argument-hint: [search query]
---

# Perplexity Search Command

Execute a search using the Perplexity API and return formatted results with source attribution.

**Usage:** `/search:perplexity [your search query]`

**Requirements:** `PERPLEXITY_API_KEY` environment variable must be set

```bash
#!/bin/bash

# Check if API key is set
if [ -z "$PERPLEXITY_API_KEY" ]; then
  echo "ERROR: PERPLEXITY_API_KEY environment variable not set"
  echo "Please set your Perplexity API key: export PERPLEXITY_API_KEY='your-key-here'"
  exit 1
fi

# Get query from arguments
QUERY="$ARGUMENTS"

if [ -z "$QUERY" ]; then
  echo "ERROR: No search query provided"
  echo "Usage: /search:perplexity [your search query]"
  exit 1
fi

# Make API request to Perplexity Search endpoint
RESPONSE=$(curl -s -X POST "https://api.perplexity.ai/search" \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"$QUERY\",
    \"max_results\": 10
  }")

# Check if curl command succeeded
if [ $? -ne 0 ]; then
  echo "ERROR: Failed to connect to Perplexity API"
  exit 1
fi

# Check if response contains error
if echo "$RESPONSE" | grep -q '"error"'; then
  echo "ERROR: Perplexity API returned an error:"
  echo "$RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4
  exit 1
fi

# Parse and format results
echo "=== Perplexity Search Results for: $QUERY ==="
echo ""

# Extract results array and format each result
echo "$RESPONSE" | python3 -c "
import sys
import json

try:
    data = json.load(sys.stdin)
    results = data.get('results', [])

    if not results:
        print('No results found.')
        sys.exit(0)

    for i, result in enumerate(results, 1):
        title = result.get('title', 'No title')
        url = result.get('url', 'No URL')
        snippet = result.get('snippet', 'No snippet available')
        date = result.get('date', 'Date unknown')

        print(f'{i}. {title}')
        print(f'   URL: {url}')
        print(f'   Date: {date}')
        print(f'   Snippet: {snippet}')
        print()

except json.JSONDecodeError:
    print('ERROR: Failed to parse API response')
    sys.exit(1)
except Exception as e:
    print(f'ERROR: {str(e)}')
    sys.exit(1)
"

# Check if Python parsing succeeded
if [ $? -ne 0 ]; then
  echo ""
  echo "Raw API Response:"
  echo "$RESPONSE"
  exit 1
fi

echo "=== End of Results ==="
```
