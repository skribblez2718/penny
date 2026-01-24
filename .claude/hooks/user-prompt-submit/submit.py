"""
UserPromptSubmit Hook - Reasoning Protocol Enforcement
=======================================================

This hook executes the Mandatory Reasoning Protocol for EVERY prompt.

Supported prompt flags (can appear in any order at end of prompt):
    -i    Improve prompt via external model before processing
    -b    Bypass reasoning protocol (bypass mode)

Examples:
    "fix the bug -b"           → Bypass reasoning, execute directly
    "add feature -i"           → Improve prompt, then run reasoning
    "refactor code -i -b"      → Improve prompt, then bypass reasoning
    "refactor code -b -i"      → Same as above (order doesn't matter)

For the main orchestrator:
    - Uses entry.py with full 8-step protocol
    - Always starts fresh session

For Cognitive Agents (subagents):
    - Uses entry.py --agent-mode which SKIPS Step 4 (Task Routing)
    - Agents are already routed by skill orchestration

For Bypass Mode (-b flag):
    - Exits early, allowing Claude to handle the prompt directly
    - Useful for trivial tasks and follow-up prompts

This is the ENFORCEMENT mechanism that guarantees Python orchestration runs.
"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Optional, TextIO, Tuple, TypedDict, cast

# Import shared directive core (use sys.path.insert - NEVER relative imports)
_ORCHESTRATION_ROOT = Path(__file__).resolve().parent.parent.parent / "orchestration"
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))
from directives.base import _format_directive_core


class HookInput(TypedDict, total=False):
    """
    Typed view of the JSON object Claude Code passes to hooks.
    """

    session_id: str
    transcript_path: str
    cwd: str
    permission_mode: str
    hook_event_name: str
    prompt: str


class ParsedPrompt(TypedDict):
    """Result of parsing flags from a prompt."""

    content: str    # The prompt text with flags stripped
    improve: bool   # -i flag: improve prompt via external model
    bypass: bool    # -b flag: bypass reasoning protocol


# Known prompt flags - add new flags here
# Maps flag string to attribute name in ParsedPrompt
PROMPT_FLAGS: dict[str, str] = {
    '-i': 'improve',    # Improve prompt via external model
    '-b': 'bypass',     # Bypass reasoning protocol
}


def _read_json_from_stdin(stdin: TextIO = sys.stdin) -> HookInput:
    """
    Read and return a JSON object from ``stdin`` as a :class:`HookInput`.
    """
    obj: Any = json.load(stdin)
    if not isinstance(obj, dict):
        raise TypeError("expected a JSON object at the top level")
    return cast(HookInput, obj)


def _extract_prompt(payload: HookInput) -> str:
    """
    Extract the ``prompt`` field from the payload.
    """
    value: Any = payload.get("prompt", "")
    return value if isinstance(value, str) else ""


def parse_prompt_flags(prompt: str) -> ParsedPrompt:
    """
    Parse CLI-style flags from the end of a prompt.

    Flags can appear in any order at the end of the prompt.
    Only flags at the very end are recognized - flags embedded
    in the middle of text are treated as content.

    Examples:
        "my prompt -b"      → content="my prompt", bypass=True
        "my prompt -i -b"   → content="my prompt", improve=True, bypass=True
        "my prompt -b -i"   → content="my prompt", improve=True, bypass=True
        "my prompt"         → content="my prompt", all flags False
        "use -i flag -b"    → content="use -i flag", bypass=True

    Args:
        prompt: The raw user prompt potentially ending with flags

    Returns:
        ParsedPrompt with content and flag states
    """
    result: ParsedPrompt = {
        'content': prompt,
        'improve': False,
        'bypass': False,
    }

    # Split prompt into words and scan from the end
    words = prompt.rstrip().split()
    if not words:
        return result

    # Collect flags from the end of the prompt
    flags_found: list[str] = []
    while words and words[-1] in PROMPT_FLAGS:
        flag = words.pop()
        flags_found.append(flag)

    # Set flag states
    for flag in flags_found:
        attr_name = PROMPT_FLAGS[flag]
        result[attr_name] = True  # type: ignore[literal-required]

    # Reconstruct content without flags
    result['content'] = ' '.join(words).rstrip()

    return result


def is_subagent_session() -> bool:
    """
    Detect if running in a subagent context.

    Subagents are detected by:
    1. CLAUDE_PROJECT_DIR containing '/.claude/agents/' path
    2. CLAUDE_AGENT_TYPE environment variable being set

    Returns:
        True if this is a subagent session, False otherwise
    """
    # Check for agent-specific project directory
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    normalized = project_dir.replace("\\", "/")
    if "/.claude/agents/" in normalized:
        return True

    # Check for explicit agent type marker
    if os.environ.get("CLAUDE_AGENT_TYPE") is not None:
        return True

    return False


def improve_prompt(prompt: str) -> Optional[str]:
    """
    Send prompt to OPENAI_BASE_URL/chat/completions for improvement.
    Uses OPENAI_PROMPT_IMPROVER_MODEL for the model.

    Args:
        prompt: The user's original prompt (with -i suffix already stripped)

    Returns:
        Improved prompt text, or None on failure
    """
    base_url = os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get("OPENAI_API_KEY", "")
    model = os.environ.get("OPENAI_PROMPT_IMPROVER_MODEL")

    # Validate required environment variables
    missing_vars = []
    if not base_url:
        missing_vars.append("OPENAI_BASE_URL")
    if not model:
        missing_vars.append("OPENAI_PROMPT_IMPROVER_MODEL")

    if missing_vars:
        print(f"[prompt-improve] ERROR: Missing required env vars: {', '.join(missing_vars)}", file=sys.stderr)
        return None

    if not api_key:
        print("[prompt-improve] WARNING: OPENAI_API_KEY not set, proceeding without auth", file=sys.stderr)

    url = f"{base_url.rstrip('/')}/chat/completions"
    print(f"[prompt-improve] Calling: {url} with model: {model}", file=sys.stderr)

    request_payload = {
        "model": model,
        "stream": True,  # Enable streaming for reasoning models
        "messages": [
            {
                "role": "user",
                "content": f"Improve the below prompt and optimize it for Claude Opus:\n\n```markdown\n{prompt}\n```"
            }
        ]
    }

    req = urllib.request.Request(url, method='POST')
    req.add_header('Content-Type', 'application/json')
    if api_key:
        req.add_header('Authorization', f'Bearer {api_key}')

    try:
        data = json.dumps(request_payload).encode('utf-8')
    except (TypeError, ValueError) as e:
        print(f"[prompt-improve] ERROR: Failed to serialize request payload: {e}", file=sys.stderr)
        return None

    # Create SSL context that doesn't verify certificates
    # User-specified OPENAI_BASE_URL is trusted (may use internal/self-signed certs)
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    try:
        response = urllib.request.urlopen(req, data=data, timeout=180, context=ssl_context)
        status_code = response.status

        if status_code != 200:
            print(f"[prompt-improve] ERROR: Unexpected status code: {status_code}", file=sys.stderr)
            return None

        # Process streaming response - accumulate content from delta chunks
        # Reasoning models stream reasoning tokens first, then content
        # We accumulate BOTH content and reasoning_content, preferring content
        # Some models (like gpt-oss) may output ONLY reasoning_content
        debug_mode = os.environ.get("OPENAI_PROMPT_IMPROVE_DEBUG", "").lower() in ("1", "true", "yes")
        accumulated_content = ""
        accumulated_reasoning = ""
        chunk_count = 0

        for line in response:
            # Decode line
            try:
                line_text = line.decode('utf-8').strip()
            except UnicodeDecodeError:
                continue  # Skip malformed lines

            # Skip empty lines and SSE comments
            if not line_text or line_text.startswith(':'):
                continue

            # Handle SSE data prefix OR raw NDJSON (no prefix)
            if line_text.startswith('data: '):
                line_text = line_text[6:]
            elif not line_text.startswith('{'):
                # Not SSE data line and not raw JSON - skip
                continue

            # Check for stream end
            if line_text == '[DONE]':
                break

            # Parse JSON chunk
            try:
                chunk = json.loads(line_text)
                chunk_count += 1

                # Debug logging for first 3 chunks
                if debug_mode and chunk_count <= 3:
                    print(f"[prompt-improve] DEBUG chunk {chunk_count}: {line_text[:200]}", file=sys.stderr)

                choices = chunk.get('choices', [])
                if choices:
                    choice = choices[0]
                    delta = choice.get('delta', {})
                    message = choice.get('message', {})  # Non-streaming format

                    # Check all possible content locations
                    content = (
                        delta.get('content') or
                        message.get('content') or
                        choice.get('text')  # Legacy completions format
                    )
                    reasoning = (
                        delta.get('reasoning_content') or
                        message.get('reasoning_content')
                    )

                    # Accumulate BOTH types (no longer skipping reasoning)
                    if reasoning:
                        accumulated_reasoning += reasoning
                    if content:
                        accumulated_content += content

            except json.JSONDecodeError:
                if debug_mode:
                    print(f"[prompt-improve] DEBUG: JSON decode failed for: {line_text[:100]}", file=sys.stderr)
                continue  # Skip malformed chunks

        # Determine final content: prefer content, fallback to reasoning
        final_content = accumulated_content.strip() if accumulated_content.strip() else accumulated_reasoning.strip()

        # Return accumulated content
        print(f"[prompt-improve] Processed {chunk_count} chunks", file=sys.stderr)
        print(f"[prompt-improve] Content length: {len(accumulated_content)}, Reasoning length: {len(accumulated_reasoning)}", file=sys.stderr)

        if final_content:
            print(f"[prompt-improve] SUCCESS: Improved prompt length: {len(final_content)} chars", file=sys.stderr)
            return final_content

        # Phase 2: Non-streaming fallback if streaming returned empty
        print("[prompt-improve] Streaming returned empty, trying non-streaming fallback...", file=sys.stderr)

        # Retry with stream=false
        request_payload["stream"] = False
        try:
            fallback_data = json.dumps(request_payload).encode('utf-8')
            fallback_req = urllib.request.Request(url, method='POST')
            fallback_req.add_header('Content-Type', 'application/json')
            if api_key:
                fallback_req.add_header('Authorization', f'Bearer {api_key}')

            fallback_response = urllib.request.urlopen(fallback_req, data=fallback_data, timeout=180, context=ssl_context)
            if fallback_response.status == 200:
                fallback_body = fallback_response.read().decode('utf-8')
                fallback_json = json.loads(fallback_body)

                if debug_mode:
                    print(f"[prompt-improve] DEBUG non-streaming response: {fallback_body[:500]}", file=sys.stderr)

                choices = fallback_json.get('choices', [])
                if choices:
                    message = choices[0].get('message', {})
                    content = message.get('content') or message.get('reasoning_content')
                    if content:
                        content = content.strip()
                        print(f"[prompt-improve] SUCCESS (non-streaming fallback): {len(content)} chars", file=sys.stderr)
                        return content

            print("[prompt-improve] ERROR: Non-streaming fallback also returned no content", file=sys.stderr)
        except Exception as fallback_err:
            print(f"[prompt-improve] ERROR: Non-streaming fallback failed: {fallback_err}", file=sys.stderr)

        return None

    except urllib.error.HTTPError as e:
        error_body = ""
        try:
            error_body = e.read().decode('utf-8', errors='replace')[:500]
        except Exception:
            pass
        print(f"[prompt-improve] HTTP ERROR ({e.code}): {e.reason}", file=sys.stderr)
        if error_body:
            print(f"[prompt-improve] Error response body: {error_body}", file=sys.stderr)

    except urllib.error.URLError as e:
        print(f"[prompt-improve] URL ERROR: {e.reason}", file=sys.stderr)
        if hasattr(e.reason, 'errno'):
            print(f"[prompt-improve] Error number: {e.reason.errno}", file=sys.stderr)
        if hasattr(e.reason, 'strerror'):
            print(f"[prompt-improve] Error string: {e.reason.strerror}", file=sys.stderr)

    except TimeoutError:
        print("[prompt-improve] ERROR: Request timed out after 180 seconds", file=sys.stderr)

    except ssl.SSLError as e:
        print(f"[prompt-improve] SSL ERROR: {e}", file=sys.stderr)

    except ConnectionError as e:
        print(f"[prompt-improve] CONNECTION ERROR: {e}", file=sys.stderr)

    except Exception as e:
        print(f"[prompt-improve] UNEXPECTED ERROR ({type(e).__name__}): {e}", file=sys.stderr)
        import traceback
        print(f"[prompt-improve] Traceback: {traceback.format_exc()}", file=sys.stderr)

    return None


def handle_prompt_improvement(prompt: str, pai_dir: str) -> Tuple[bool, str]:
    """
    Handle -i flag: improve prompt via external model.

    Returns the improved prompt (or original on failure) so the caller
    can continue with normal reasoning protocol flow.

    Args:
        prompt: The user's prompt (flags already stripped by parser)
        pai_dir: CAII_DIRECTORY path for reasoning protocol

    Returns:
        Tuple of (success, prompt_to_use) - prompt_to_use is improved or original
    """
    print(f"[prompt-improve] Starting improvement for prompt ({len(prompt)} chars)", file=sys.stderr)

    # Attempt improvement (prompt already has flags stripped)
    try:
        improved = improve_prompt(prompt)
    except Exception as e:
        print(f"[prompt-improve] CRITICAL: Uncaught exception in improve_prompt: {type(e).__name__}: {e}", file=sys.stderr)
        import traceback
        print(f"[prompt-improve] Traceback: {traceback.format_exc()}", file=sys.stderr)
        improved = None

    if improved:
        # Success: Return improved prompt
        print(f"[prompt-improve] Returning improved prompt ({len(improved)} chars)", file=sys.stderr)
        return (True, improved)
    else:
        # Failure: Return original prompt
        print("[prompt-improve] FAILED: Using original prompt instead", file=sys.stderr)
        return (False, prompt)


def check_pending_dispatch(pai_dir: str) -> Tuple[bool, str]:
    """
    Check if there's a pending dispatch from a completed reasoning session.

    This ensures the execution chain continues even if the dispatcher
    directive printed by complete.py wasn't processed.

    Args:
        pai_dir: CAII_DIRECTORY path

    Returns:
        Tuple of (has_pending, dispatch_directive)
    """
    # Import ProtocolState to check for pending dispatch
    # Must add protocols directory to path for fully-qualified imports
    protocols_path = Path(pai_dir) / ".claude/orchestration/protocols"
    if str(protocols_path) not in sys.path:
        sys.path.insert(0, str(protocols_path))

    try:
        from reasoning.core.state import ProtocolState

        state = ProtocolState.find_with_pending_dispatch()
        if state and state.dispatch_pending:
            dispatch_info = state.dispatch_pending
            directive_command = dispatch_info.get("directive_command", "")
            route = dispatch_info.get("route", "")

            # Use shared directive formatting
            directive = _format_directive_core(
                directive_command,
                context="The execution chain MUST continue.",
                warnings=[f"Pending dispatch from completed reasoning protocol (route: {route}). Execute this command NOW."]
            )
            # Clear the pending dispatch now that we've injected it
            state.clear_dispatch_pending()
            state.save()

            return (True, directive)

    except Exception as e:
        print(f"Error checking pending dispatch: {e}", file=sys.stderr)

    return (False, "")


def main() -> None:
    """
    Execute appropriate reasoning protocol entry point.

    For Main Orchestrator: Uses entry.py (full 8 steps)
    For Agents: Uses entry.py --agent-mode (skips Step 4)

    The stdout becomes part of Claude's context, containing:
    - Improved prompt (if -i flag used)
    - MANDATORY directive to execute reasoning protocol

    Exit codes:
    * ``0`` - Success
    * ``1`` - Error (message written to ``stderr``; non-blocking)
    """
    try:
        # Read and parse input payload
        try:
            payload = _read_json_from_stdin()
        except json.JSONDecodeError as e:
            print(f"[hook] ERROR: Failed to parse JSON from stdin: {e}", file=sys.stderr)
            sys.exit(1)
        except TypeError as e:
            print(f"[hook] ERROR: Invalid payload type: {e}", file=sys.stderr)
            sys.exit(1)

        try:
            prompt = _extract_prompt(payload)
        except Exception as e:
            print(f"[hook] ERROR: Failed to extract prompt from payload: {e}", file=sys.stderr)
            sys.exit(1)

        if not prompt.strip():
            print("[hook] Empty prompt, exiting cleanly", file=sys.stderr)
            sys.exit(0)  # Empty prompt, nothing to do

        # Get CAII_DIRECTORY early (needed for prompt improvement)
        pai_dir = os.environ.get("CAII_DIRECTORY")
        if not pai_dir:
            print("[hook] ERROR: CAII_DIRECTORY environment variable not set", file=sys.stderr)
            sys.exit(1)

        if not Path(pai_dir).exists():
            print(f"[hook] ERROR: CAII_DIRECTORY does not exist: {pai_dir}", file=sys.stderr)
            sys.exit(1)

        # Parse flags from prompt (order-independent)
        try:
            parsed = parse_prompt_flags(prompt)
            prompt = parsed['content']
            print(f"[hook] Parsed flags - improve: {parsed['improve']}, bypass: {parsed['bypass']}", file=sys.stderr)
        except Exception as e:
            print(f"[hook] ERROR: Failed to parse prompt flags: {e}", file=sys.stderr)
            # Continue with original prompt if flag parsing fails
            parsed = {'content': prompt, 'improve': False, 'bypass': False}

        # Handle -i flag: improve prompt via external model
        # The improved prompt will be shown via entry.py's "Query: ..." output
        # followed immediately by the MANDATORY directive
        if parsed['improve']:
            print("[hook] Processing -i flag for prompt improvement", file=sys.stderr)
            try:
                success, prompt = handle_prompt_improvement(prompt, pai_dir)
                if success:
                    print("[hook] Prompt improvement succeeded", file=sys.stderr)
                else:
                    print("[hook] Prompt improvement failed, using original", file=sys.stderr)
            except Exception as e:
                print(f"[hook] ERROR: Exception during prompt improvement: {type(e).__name__}: {e}", file=sys.stderr)
                import traceback
                print(f"[hook] Traceback: {traceback.format_exc()}", file=sys.stderr)
                # Continue with original prompt on failure

        # Handle -b flag: bypass reasoning protocol entirely
        # Exit silently - Claude sees just the clean prompt
        if parsed['bypass']:
            print("[hook] Bypass flag detected, skipping reasoning protocol", file=sys.stderr)
            sys.exit(0)

        # Check for pending dispatch FIRST (ensures execution chain continues)
        # Only check for main orchestrator context, not subagents
        if not is_subagent_session():
            try:
                has_pending, dispatch_directive = check_pending_dispatch(pai_dir)
                if has_pending:
                    print("[hook] Found pending dispatch, injecting directive", file=sys.stderr)
                    # Output the pending dispatch directive before normal reasoning
                    print(dispatch_directive, flush=True)
                    # Continue with normal reasoning protocol for the new prompt
            except Exception as e:
                print(f"[hook] WARNING: Failed to check pending dispatch: {e}", file=sys.stderr)
                # Continue anyway - this is not critical

        # Determine context type and set flags
        is_agent = is_subagent_session()
        context_type = "agent" if is_agent else "orchestrator"
        print(f"[hook] Context type: {context_type}", file=sys.stderr)

        # Both main orchestrator and Agent contexts use unified entry.py
        entry_script = Path(pai_dir) / ".claude/orchestration/protocols/reasoning/entry.py"

        if not entry_script.exists():
            print(f"[hook] ERROR: entry.py not found at: {entry_script}", file=sys.stderr)
            sys.exit(1)

        # Build command arguments
        # Use '--' separator to prevent prompts starting with '-' or '--'
        # from being misinterpreted as command-line flags by argparse
        cmd_args = ["python3", str(entry_script)]

        # Add optional flags before positional args
        if is_agent:
            cmd_args.append("--agent-mode")

        # Add the prompt after '--' separator
        cmd_args.extend(["--", prompt])

        print(f"[hook] Executing: {' '.join(cmd_args[:3])}...", file=sys.stderr)

        # Execute entry point with the prompt
        # Use PYTHONUNBUFFERED=1 to ensure stdout is flushed immediately
        try:
            result = subprocess.run(
                cmd_args,
                capture_output=True,
                text=True,
                cwd=pai_dir,
                timeout=30,  # 30 second timeout
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
        except subprocess.TimeoutExpired as e:
            print(f"[hook] ERROR: entry.py timed out after 30 seconds", file=sys.stderr)
            if e.stdout:
                print(f"[hook] Partial stdout: {e.stdout[:500]}", file=sys.stderr)
            if e.stderr:
                print(f"[hook] Partial stderr: {e.stderr[:500]}", file=sys.stderr)
            sys.exit(1)
        except FileNotFoundError as e:
            print(f"[hook] ERROR: python3 not found or entry.py missing: {e}", file=sys.stderr)
            sys.exit(1)
        except PermissionError as e:
            print(f"[hook] ERROR: Permission denied executing entry.py: {e}", file=sys.stderr)
            sys.exit(1)
        except OSError as e:
            print(f"[hook] ERROR: OS error running entry.py: {e}", file=sys.stderr)
            sys.exit(1)

        # Print stdout - this becomes Claude's context
        if result.stdout:
            print(result.stdout, flush=True)
        else:
            print("[hook] WARNING: entry.py produced no stdout", file=sys.stderr)

        # Log stderr but don't fail the hook
        if result.stderr:
            print(f"[hook] {context_type} entry stderr: {result.stderr}", file=sys.stderr)

        # Check return code
        if result.returncode != 0:
            print(f"[hook] WARNING: entry.py exited with code {result.returncode}", file=sys.stderr)

        sys.exit(0)

    except KeyboardInterrupt:
        print("[hook] Interrupted by user", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"[hook] CRITICAL ERROR ({type(exc).__name__}): {exc}", file=sys.stderr)
        import traceback
        print(f"[hook] Traceback: {traceback.format_exc()}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
