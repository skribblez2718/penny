#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# Extract data from JSON input
current_dir=$(echo "$input" | jq -r '.workspace.current_dir')
model_name=$(echo "$input" | jq -r '.model.display_name')
model_id=$(echo "$input" | jq -r '.model.id // ""')

# Get directory name
dir_name=$(basename "$current_dir")

# ============================================================
# TOKEN USAGE AND COST TRACKING
# ============================================================
# Tracks usage locally by accumulating session data
# Cost uses Claude's reported total_cost_usd (includes discounts)

# Extract session token data from JSON input
session_input_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
session_output_tokens=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
session_cost=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')

# Extract cache tokens from current usage
cache_read_tokens=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')

# Usage tracking file (single file, resets each month)
usage_dir="${CAII_DIRECTORY}/.claude/usage"
current_month=$(date +%Y-%m)
usage_file="${usage_dir}/usage.json"

# Ensure usage directory exists
mkdir -p "$usage_dir" 2>/dev/null

# Initialize or load cumulative usage
if [ -f "$usage_file" ]; then
    stored_month=$(jq -r '.month // ""' "$usage_file" 2>/dev/null || echo "")

    # Reset if month has changed (new billing cycle)
    if [ "$stored_month" != "$current_month" ]; then
        cumulative_input=0
        cumulative_output=0
        cumulative_cost=0
        last_session_input=0
        last_session_output=0
        last_session_cost=0
    else
        cumulative_input=$(jq -r '.cumulative_input_tokens // 0' "$usage_file" 2>/dev/null || echo "0")
        cumulative_output=$(jq -r '.cumulative_output_tokens // 0' "$usage_file" 2>/dev/null || echo "0")
        cumulative_cost=$(jq -r '.cumulative_cost // 0' "$usage_file" 2>/dev/null || echo "0")
        last_session_input=$(jq -r '.last_session_input // 0' "$usage_file" 2>/dev/null || echo "0")
        last_session_output=$(jq -r '.last_session_output // 0' "$usage_file" 2>/dev/null || echo "0")
        last_session_cost=$(jq -r '.last_session_cost // 0' "$usage_file" 2>/dev/null || echo "0.0")
    fi
else
    cumulative_input=0
    cumulative_output=0
    cumulative_cost=0
    last_session_input=0
    last_session_output=0
    last_session_cost=0
fi

# Only add to cumulative if session values have increased (avoid double-counting)
if [ "$session_input_tokens" -gt "$last_session_input" ] 2>/dev/null; then
    delta_input=$((session_input_tokens - last_session_input))
    cumulative_input=$((cumulative_input + delta_input))
fi

if [ "$session_output_tokens" -gt "$last_session_output" ] 2>/dev/null; then
    delta_output=$((session_output_tokens - last_session_output))
    cumulative_output=$((cumulative_output + delta_output))
fi

# Accumulate cost using awk for proper float handling
# Handles: same session growth (add delta), new session start (add entire session cost)
cumulative_cost=$(awk -v sess="$session_cost" -v last="$last_session_cost" -v cum="$cumulative_cost" \
    'BEGIN {
        if (sess > last) {
            delta = sess - last
            printf "%.6f", cum + delta
        } else if (sess > 0 && sess < last) {
            printf "%.6f", cum + sess
        } else {
            printf "%.6f", cum
        }
    }')

# Save updated cumulative data
cat > "$usage_file" << EOF
{
    "month": "$current_month",
    "cumulative_input_tokens": $cumulative_input,
    "cumulative_output_tokens": $cumulative_output,
    "cumulative_cost": $cumulative_cost,
    "last_session_input": $session_input_tokens,
    "last_session_output": $session_output_tokens,
    "last_session_cost": $session_cost,
    "model_id": "$model_id",
    "last_updated": "$(date -Iseconds)"
}
EOF

# Monthly cost
monthly_cost=$(awk -v c="${cumulative_cost:-0}" 'BEGIN { printf "%.2f", c }')

# Format token counts for display (K for thousands, M for millions)
format_tokens() {
    local tokens=${1:-0}
    if [ "$tokens" -ge 1000000 ] 2>/dev/null; then
        awk -v t="$tokens" 'BEGIN { printf "%.1fM", t / 1000000 }'
    elif [ "$tokens" -ge 1000 ] 2>/dev/null; then
        awk -v t="$tokens" 'BEGIN { printf "%.1fK", t / 1000 }'
    else
        echo "$tokens"
    fi
}

monthly_input_fmt=$(format_tokens "$cumulative_input")
monthly_output_fmt=$(format_tokens "$cumulative_output")
cache_read_fmt=$(format_tokens "$cache_read_tokens")

# Count items from specified directories
# - Commands from ${CAII_DIRECTORY}/.claude/commands/
# - MCPs from settings.json
# - Skills from ${CAII_DIRECTORY}/.claude/skills/
claude_dir="${CAII_DIRECTORY}/.claude"
commands_count=0
mcps_count=0
skills_count=0

# Count commands (all .md files in commands directory and subdirectories, excluding templates)
if [ -d "$claude_dir/commands" ]; then
    commands_count=$(find "$claude_dir/commands" -name "*.md" ! -name "*template*" 2>/dev/null | wc -l | tr -d ' ')
fi

# Count MCPs using claude mcp list (authoritative source for all scopes including plugins)
# This captures user-scoped, project-scoped, and plugin-provided MCP servers
mcp_list_output=$(claude mcp list 2>/dev/null || echo "")

# Check if output indicates no servers configured
if echo "$mcp_list_output" | grep -qi "no mcp servers"; then
    mcps_count=0
    mcp_names_raw=""
elif [ -n "$mcp_list_output" ]; then
    # Filter out status/health check messages and extract just server names
    # Format of server lines: "server-name: url (type) - status"
    # We want to extract just the server name (before the colon)
    # Also filter out: empty lines, "Checking", "No ", "Use ", lines with URLs
    mcp_names_raw=$(echo "$mcp_list_output" | \
        grep -v '^$' | \
        grep -v -i "^Checking" | \
        grep -v -i "^No " | \
        grep -v -i "^Use " | \
        grep -v -i "Health" | \
        grep ':' | \
        sed 's/:.*$//' | \
        tr '\n' ' ')
    # Count the extracted names
    mcps_count=$(echo "$mcp_names_raw" | wc -w | tr -d ' ')
else
    mcps_count=0
    mcp_names_raw=""
fi

# Count Skills (directories in .claude/skills)
if [ -d "$claude_dir/skills" ]; then
    skills_count=$(find "$claude_dir/skills" -maxdepth 1 -type d ! -path "$claude_dir/skills" 2>/dev/null | wc -l | tr -d ' ')
fi

# Atom One Dark Color Scheme
# Background: #282c34 (dark gray)
# Foreground: #abb2bf (light gray)
# Blue: #61afef
# Purple: #c678dd
# Green: #98c379
# Orange: #d19a66
# Red: #e06c75
# Yellow: #e5c07b
# Cyan: #56b6c2

# Atom One Dark - Line-Based Color Scheme
# Design Philosophy: Each line has a distinct dominant color for visual separation

# Base colors
BACKGROUND='\033[48;2;40;44;52m'     # #282c34 - Dark gray background
BRIGHT_PURPLE='\033[38;2;198;120;221m'  # #c678dd - Line 1 primary color
BRIGHT_BLUE='\033[38;2;97;175;239m'     # #61afef - Line 2 primary color
DARK_BLUE='\033[38;2;85;155;210m'       # Darker blue variant for Line 2
BRIGHT_GREEN='\033[38;2;152;195;121m'    # #98c379 - Line 3 primary color
DARK_GREEN='\033[38;2;130;170;100m'      # Darker green variant for Line 3
BRIGHT_ORANGE='\033[38;2;209;154;102m'   # #d19a66 - Orange for model name
BRIGHT_RED='\033[38;2;224;108;117m'      # #e06c75 - Bright red for errors

# White color for connecting words, numbers, and values
WHITE='\033[38;2;255;255;255m'

# Line-specific color assignments
# LINE 1 - Updated with white connecting words and orange model
LINE1_PRIMARY="$BRIGHT_PURPLE"       # Primary purple for DA name
MODEL_COLOR="$BRIGHT_ORANGE"         # Orange for model name
CONNECTING_WORDS="$WHITE"            # White for "here running on", "in", "wielding", "and"
NUMBERS_COLOR="$WHITE"               # White for all numbers
CATEGORY_COLOR="$DARK_BLUE"          # Dark blue for Commands, Skills, MCPs (same as line 2 labels)

# LINE 2 - MOSTLY DARK BLUE
LINE2_PRIMARY="$DARK_BLUE"           # Primary dark blue for "MCPs:" and "Skills:" labels
MCP_NAMES_COLOR="$WHITE"             # White for MCP server names and skill names

# Separators and punctuation - subtle for all lines
SEPARATOR_COLOR='\033[38;2;171;178;191m' # #abb2bf - Subtle gray for separators (using foreground color)

RESET='\033[0m'                      # Reset all formatting

# Format MCP names from claude mcp list output (already stored in mcp_names_raw)
# Preserve original case and formatting exactly as reported by Claude Code
mcp_names_formatted=""

for mcp in $mcp_names_raw; do
    # Use MCP name exactly as extracted - no transformation
    formatted="${MCP_NAMES_COLOR}${mcp}${RESET}"

    if [ -z "$mcp_names_formatted" ]; then
        mcp_names_formatted="$formatted"
    else
        mcp_names_formatted="$mcp_names_formatted${SEPARATOR_COLOR}, ${formatted}"
    fi
done

# Set to "None" if no MCPs found
if [ -z "$mcp_names_formatted" ]; then
    mcp_names_formatted="${SEPARATOR_COLOR}None${RESET}"
fi

# Get Command names - format as /<verb>:<noun>
# Structure: .claude/commands/<verb>/<noun>.md
command_names_formatted=""
if [ -d "$claude_dir/commands" ]; then
    while IFS= read -r cmd_path; do
        # Extract verb (parent directory) and noun (filename without .md)
        verb=$(basename "$(dirname "$cmd_path")")
        noun=$(basename "$cmd_path" .md)
        # Format as /<verb>:<noun>
        formatted="${MCP_NAMES_COLOR}/${verb}:${noun}${RESET}"

        if [ -z "$command_names_formatted" ]; then
            command_names_formatted="$formatted"
        else
            command_names_formatted="$command_names_formatted${SEPARATOR_COLOR}, ${formatted}"
        fi
    done < <(find "$claude_dir/commands" -name "*.md" ! -name "*template*" 2>/dev/null | sort)
fi

# Set to "None" if no commands found
if [ -z "$command_names_formatted" ]; then
    command_names_formatted="${SEPARATOR_COLOR}None${RESET}"
fi

# Get Skill names - preserve lowercase with hyphens (no transformation)
skill_names_formatted=""
if [ -d "$claude_dir/skills" ]; then
    skill_names_raw=$(find "$claude_dir/skills" -maxdepth 1 -type d ! -path "$claude_dir/skills" -exec basename {} \; 2>/dev/null | sort | tr '\n' ' ')
    # Keep skill names as-is (lowercase with hyphens preserved)
    for skill in $skill_names_raw; do
        # Use the skill name directly without transformation
        formatted="${MCP_NAMES_COLOR}${skill}${RESET}"

        if [ -z "$skill_names_formatted" ]; then
            skill_names_formatted="$formatted"
        else
            skill_names_formatted="$skill_names_formatted${SEPARATOR_COLOR}, ${formatted}"
        fi
    done
fi

# Set to "None" if no skills found
if [ -z "$skill_names_formatted" ]; then
    skill_names_formatted="${SEPARATOR_COLOR}None${RESET}"
fi

# Output the line-based color themed statusline
# Cyan color for directory (Atom One Dark cyan)
DIR_COLOR='\033[38;2;86;182;194m'  # #56b6c2 - Atom One Dark cyan for directory

# LINE 1 - DA name (purple), connecting words (white), model (orange), numbers (white), categories (dark blue)
da_name="${DA_NAME:-AI Assistant}"
printf "${LINE1_PRIMARY}${da_name}${RESET}${CONNECTING_WORDS} here, running on ${RESET}${MODEL_COLOR}🧠 ${model_name}${RESET}${CONNECTING_WORDS} in ${RESET}${DIR_COLOR}📁 ${dir_name}${RESET}${CONNECTING_WORDS}, wielding: ${RESET}${CONNECTING_WORDS}🪄  ${RESET}${NUMBERS_COLOR}${commands_count}${RESET} ${CATEGORY_COLOR}Commands${RESET}${CONNECTING_WORDS}, ${RESET}${CONNECTING_WORDS}🎯 ${RESET}${NUMBERS_COLOR}${skills_count}${RESET} ${CATEGORY_COLOR}Skills${RESET}${CONNECTING_WORDS}, and ${RESET}${CONNECTING_WORDS}🔌 ${RESET}${NUMBERS_COLOR}${mcps_count}${RESET} ${CATEGORY_COLOR}MCPs${RESET}\n"

# LINE 2 - Commands label (dark blue), Command names (white)
printf "${LINE2_PRIMARY}🪄 Commands${RESET}${SEPARATOR_COLOR}: ${RESET}${command_names_formatted}${RESET}\n"

# LINE 3 - Skills label (dark blue), Skill names (white)
printf "${LINE2_PRIMARY}🎯 Skills${RESET}${SEPARATOR_COLOR}: ${RESET}${skill_names_formatted}${RESET}\n"

# LINE 4 - MCPs label (dark blue), MCP names (white)
printf "${LINE2_PRIMARY}🔌 MCPs${RESET}${SEPARATOR_COLOR}: ${RESET}${mcp_names_formatted}${RESET}\n"

# LINE 5 - Token Usage and Cost Tracking
# Yellow color for cost/usage line (Atom One Dark yellow)
BRIGHT_YELLOW='\033[38;2;229;192;123m'  # #e5c07b - Yellow for cost line
COST_LABEL_COLOR="$BRIGHT_YELLOW"
COST_VALUE_COLOR="$WHITE"

# Format monthly cost to 2 decimal places
monthly_cost_display=$(printf "%.2f" "$monthly_cost" 2>/dev/null || echo "0.00")

printf "${COST_LABEL_COLOR}💰 Tokens${RESET}${SEPARATOR_COLOR}: ${RESET}"
printf "${COST_VALUE_COLOR}${monthly_input_fmt}↓ ${monthly_output_fmt}↑${RESET}"
# Only show cache if there are cached tokens
if [ "$cache_read_tokens" -gt 0 ] 2>/dev/null; then
    printf "${SEPARATOR_COLOR} | ${RESET}${BRIGHT_GREEN}📦 ${cache_read_fmt} cached${RESET}"
fi
printf "${SEPARATOR_COLOR} (\$${monthly_cost_display})${RESET}\n"