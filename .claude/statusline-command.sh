#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# Extract data from JSON input
current_dir=$(echo "$input" | jq -r '.workspace.current_dir')
model_name=$(echo "$input" | jq -r '.model.display_name')

# Get directory name
dir_name=$(basename "$current_dir")

# Count items from specified directories
# - Commands from ${PAI_DIRECTORY}/.claude/commands/
# - MCPs from settings.json
# - Skills from ${PAI_DIRECTORY}/.claude/skills/
claude_dir="${PAI_DIRECTORY}/.claude"
commands_count=0
mcps_count=0
skills_count=0

# Count commands (all .md files in commands directory and subdirectories, excluding templates)
if [ -d "$claude_dir/commands" ]; then
    commands_count=$(find "$claude_dir/commands" -name "*.md" ! -name "*template*" 2>/dev/null | wc -l | tr -d ' ')
fi

# Count MCPs from settings.json
if [ -f "$claude_dir/settings.json" ]; then
    mcps_count=$(jq -r '.mcpServers | keys | length' "$claude_dir/settings.json" 2>/dev/null || echo "0")
else
    mcps_count="0"
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
LINE1_PRIMARY="$BRIGHT_PURPLE"       # Primary purple for "Penny"
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

# Get MCP names for line 2 - all in white
mcp_names_formatted=""
if [ -f "$claude_dir/settings.json" ]; then
    mcp_names_raw=$(jq -r '.mcpServers | keys[]' "$claude_dir/settings.json" 2>/dev/null | tr '\n' ' ')
    # Format MCP names - all in white
    for mcp in $mcp_names_raw; do
        case "$mcp" in
            "playwright") formatted="${MCP_NAMES_COLOR}Playwright${RESET}" ;;
            *) formatted="${MCP_NAMES_COLOR}${mcp^}${RESET}" ;;  # Capitalize first letter, white color
        esac

        if [ -z "$mcp_names_formatted" ]; then
            mcp_names_formatted="$formatted"
        else
            mcp_names_formatted="$mcp_names_formatted${SEPARATOR_COLOR}, ${formatted}"
        fi
    done
fi

# Get Command names - all in white
command_names_formatted=""
if [ -d "$claude_dir/commands" ]; then
    command_names_raw=$(find "$claude_dir/commands" -name "*.md" ! -name "*template*" -exec basename {} .md \; 2>/dev/null | tr '\n' ' ')
    # Format Command names - all in white
    for cmd in $command_names_raw; do
        # Capitalize words and replace hyphens with spaces for display
        formatted_name=$(echo "$cmd" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2));}1')
        formatted="${MCP_NAMES_COLOR}${formatted_name}${RESET}"

        if [ -z "$command_names_formatted" ]; then
            command_names_formatted="$formatted"
        else
            command_names_formatted="$command_names_formatted${SEPARATOR_COLOR}, ${formatted}"
        fi
    done
fi

# Get Skill names - all in white
skill_names_formatted=""
if [ -d "$claude_dir/skills" ]; then
    skill_names_raw=$(find "$claude_dir/skills" -maxdepth 1 -type d ! -path "$claude_dir/skills" -exec basename {} \; 2>/dev/null | tr '\n' ' ')
    # Format Skill names - all in white
    for skill in $skill_names_raw; do
        # Capitalize words and replace hyphens with spaces for display
        formatted_name=$(echo "$skill" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2));}1')
        formatted="${MCP_NAMES_COLOR}${formatted_name}${RESET}"

        if [ -z "$skill_names_formatted" ]; then
            skill_names_formatted="$formatted"
        else
            skill_names_formatted="$skill_names_formatted${SEPARATOR_COLOR}, ${formatted}"
        fi
    done
fi

# Output the line-based color themed statusline
# Cyan color for directory (Atom One Dark cyan)
DIR_COLOR='\033[38;2;86;182;194m'  # #56b6c2 - Atom One Dark cyan for directory

# LINE 1 - Penny (purple), connecting words (white), model (orange), numbers (white), categories (dark blue)
printf "${LINE1_PRIMARY}Penny${RESET}${CONNECTING_WORDS} here, running on ${RESET}${MODEL_COLOR}🧠 ${model_name}${RESET}${CONNECTING_WORDS} in ${RESET}${DIR_COLOR}📁 ${dir_name}${RESET}${CONNECTING_WORDS}, wielding: ${RESET}${CONNECTING_WORDS}🪄  ${RESET}${NUMBERS_COLOR}${commands_count}${RESET} ${CATEGORY_COLOR}Commands${RESET}${CONNECTING_WORDS}, ${RESET}${CONNECTING_WORDS}🎯 ${RESET}${NUMBERS_COLOR}${skills_count}${RESET} ${CATEGORY_COLOR}Skills${RESET}${CONNECTING_WORDS}, and ${RESET}${CONNECTING_WORDS}🔌 ${RESET}${NUMBERS_COLOR}${mcps_count}${RESET} ${CATEGORY_COLOR}MCPs${RESET}\n"

# LINE 2 - Commands label (dark blue), Command names (white)
printf "${LINE2_PRIMARY}🪄 Commands${RESET}${SEPARATOR_COLOR}: ${RESET}${command_names_formatted}${RESET}\n"

# LINE 3 - Skills label (dark blue), Skill names (white)
printf "${LINE2_PRIMARY}🎯 Skills${RESET}${SEPARATOR_COLOR}: ${RESET}${skill_names_formatted}${RESET}\n"

# LINE 4 - MCPs label (dark blue), MCP names (white)
printf "${LINE2_PRIMARY}🔌 MCPs${RESET}${SEPARATOR_COLOR}: ${RESET}${mcp_names_formatted}${RESET}\n"