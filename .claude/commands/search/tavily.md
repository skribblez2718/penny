---
description: Search using Tavily API with AI summaries and relevance scoring
argument-hint: [search query]
---

# Tavily Search Command

Execute a search using the Tavily API and return formatted results with AI summaries and relevance scoring.

**Usage:** `/search:tavily [your search query]`

**Requirements:** `TAVILY_API_KEY` environment variable must be set

```bash
#!/bin/bash

# Check if API key is set
if [ -z "$TAVILY_API_KEY" ]; then
  echo "ERROR: TAVILY_API_KEY environment variable not set"
  echo "Please set your Tavily API key: export TAVILY_API_KEY='your-key-here'"
  exit 1
fi

# Get query from arguments
QUERY="$ARGUMENTS"

if [ -z "$QUERY" ]; then
  echo "ERROR: No search query provided"
  echo "Usage: /search:tavily [your search query]"
  exit 1
fi

# Make API request to Tavily Search endpoint
RESPONSE=$(curl -s -X POST "https://api.tavily.com/search" \
  -H "Authorization: Bearer $TAVILY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"$QUERY\",
    \"search_depth\": \"advanced\",
    \"max_results\": 10,
    \"include_answer\": true
  }")

# Check if curl command succeeded
if [ $? -ne 0 ]; then
  echo "ERROR: Failed to connect to Tavily API"
  exit 1
fi

# Check if response contains error
if echo "$RESPONSE" | grep -q '"error"'; then
  echo "ERROR: Tavily API returned an error:"
  echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('error', {}).get('message', 'Unknown error'))
except:
    print('Failed to parse error response')
"
  exit 1
fi

# Parse and format results
echo "=== Tavily Search Results for: $QUERY ==="
echo ""

# Extract results array and format each result
echo "$RESPONSE" | python3 -c "
import sys
import json

try:
    data = json.load(sys.stdin)

    # Print AI-generated answer if available
    answer = data.get('answer')
    if answer:
        print('## AI Summary')
        print(answer)
        print()

    results = data.get('results', [])

    if not results:
        print('No results found.')
        sys.exit(0)

    print('## Search Results')
    print()

    for i, result in enumerate(results, 1):
        title = result.get('title', 'No title')
        url = result.get('url', 'No URL')
        content = result.get('content', 'No content available')
        score = result.get('score', 0)

        print(f'{i}. {title}')
        print(f'   URL: {url}')
        print(f'   Relevance: {score:.2f}')
        print(f'   Content: {content[:500]}...' if len(content) > 500 else f'   Content: {content}')
        print()

    # Print response time if available
    response_time = data.get('response_time')
    if response_time:
        print(f'Response time: {response_time:.2f}s')

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
