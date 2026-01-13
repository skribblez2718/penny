"""
Stop hook - Handles voice notifications when Claude completes a task.

Sends task summary to voice server for audio notification when Claude finishes responding.
Skips notification when in plan mode.

Note: Plan exit detection is now handled by PostToolUse hook for ExitPlanMode,
which directly injects the reasoning protocol directive into Claude's context.
"""

import sys
import os
import json
import urllib.request
import urllib.error
import tempfile
import subprocess
from pathlib import Path
from typing import Optional, TypedDict


#########################[ start types ]######################################
class StopHookInput(TypedDict, total=False):
    """Typed view of the JSON object Claude Code passes to Stop hook."""
    session_id: str
    transcript_path: str
    cwd: str
    permission_mode: str
    hook_event_name: str


#########################[ end types ]########################################

#########################[ start read_transcript ]###########################
def read_transcript(transcript_path: str) -> Optional[str]:
    """
    Read transcript JSONL file and extract last assistant message

    Args:
        transcript_path: Path to the transcript JSONL file

    Returns:
        The last assistant message text if found, None otherwise
    """
    try:
        if not os.path.exists(transcript_path):
            print(f"Transcript file not found: {transcript_path}", file=sys.stderr)
            return None

        # Read JSONL file line by line
        last_assistant_message = None
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    # Look for assistant messages (use 'type' not 'role')
                    if entry.get('type') == 'assistant':
                        # Extract message object first
                        message = entry.get('message', {})
                        # Extract text from message.content array
                        content = message.get('content', [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get('type') == 'text':
                                    last_assistant_message = item.get('text', '')
                        elif isinstance(content, str):
                            last_assistant_message = content
                except json.JSONDecodeError:
                    continue

        return last_assistant_message

    except Exception as e:
        print(f"Error reading transcript: {e}", file=sys.stderr)
        return None


#########################[ end read_transcript ]#############################

#########################[ start summarize_with_ai ]#########################
def summarize_with_ai(text: str) -> Optional[str]:
    """
    Send text to Open WebUI API for AI-powered summarization

    Args:
        text: The full response text to summarize

    Returns:
        AI-generated summary, or None on failure
    """
    # Get environment variables
    base_url = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8080/v1")
    api_key = os.environ.get("OPENAI_API_KEY", "")
    model = os.environ.get("OPENAI_SUMMARIZATION_MODEL", "summarizer")

    if not api_key:
        print("OPENAI_API_KEY not set, skipping AI summarization", file=sys.stderr)
        return None

    try:
        # Build the API endpoint URL
        url = f"{base_url.rstrip('/')}/chat/completions"

        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "Summarize the following text in 3-5 sentences for a voice notification. Be concise, clear, and focus on the key actions taken and results achieved. Do not use markdown, bullet points, or special formatting - output plain text only."
                },
                {
                    "role": "user",
                    "content": text
                }
            ]
        }

        # Create request with urllib
        req = urllib.request.Request(url, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Authorization', f'Bearer {api_key}')
        data = json.dumps(payload).encode('utf-8')

        response = urllib.request.urlopen(req, data=data, timeout=30)

        if response.status == 200:
            response_data = json.loads(response.read().decode('utf-8'))
            # Extract the assistant's response
            choices = response_data.get('choices', [])
            if choices and len(choices) > 0:
                message = choices[0].get('message', {})
                summary = message.get('content', '').strip()
                if summary:
                    return summary

        print("AI summarization returned no content", file=sys.stderr)
        return None

    except urllib.error.HTTPError as e:
        print(f"AI summarization error (HTTP {e.code}): {e.reason}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"Could not reach AI server: {e.reason}", file=sys.stderr)
        return None
    except json.JSONDecodeError as e:
        print(f"Failed to parse AI response: {e}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"AI summarization failed: {e}", file=sys.stderr)
        return None


#########################[ end summarize_with_ai ]###########################

#########################[ start generate_summary ]##########################
def generate_summary(text: str) -> Optional[str]:
    """
    Generate voice summary from assistant response using AI summarization

    Strategy:
    1. Check for custom voice marker (CUSTOM COMPLETED:)
    2. Use AI summarization via Open WebUI API
    3. Fall back to simple truncation if AI fails

    Args:
        text: The full response text from the assistant

    Returns:
        Voice-optimized summary, None if text is empty
    """
    if not text or not text.strip():
        return None

    text = text.strip()

    # Priority 1: Custom voice markers (user explicitly defined voice summary)
    voice_markers = ['CUSTOM COMPLETED:']
    for marker in voice_markers:
        if marker in text:
            idx = text.index(marker) + len(marker)
            summary = text[idx:].split('\n')[0].strip()
            return summary

    # Priority 2: AI summarization via Open WebUI
    ai_summary = summarize_with_ai(text)
    if ai_summary:
        return ai_summary

    # Fallback: truncate to reasonable length
    words = text.split()[:30]
    if words:
        summary = ' '.join(words)
        if not summary.endswith('.'):
            summary += '.'
        return summary

    return None


#########################[ end generate_summary ]############################

def play_audio(audio_file: str) -> bool:
    """
    Play audio file using available Linux audio players

    Args:
        audio_file: Path to the audio file

    Returns:
        True if successful, False otherwise
    """
    audio_players = ['mpg123', 'mpv', 'ffplay', 'paplay']

    for player in audio_players:
        try:
            if player == 'paplay':
                # Convert to wav for pulseaudio
                wav_file = audio_file.replace('.mp3', '.wav')
                subprocess.run(['ffmpeg', '-y', '-i', audio_file, wav_file],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                result = subprocess.run([player, wav_file],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    os.unlink(wav_file)
                except:
                    pass
                if result.returncode == 0:
                    return True
            else:
                result = subprocess.run([player, audio_file],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if result.returncode == 0:
                    return True
        except:
            continue

    return False


#########################[ end play_audio ]##################################

#########################[ start send_to_voice_server ]######################
def send_to_voice_server(summary: str, port: str = "8001") -> bool:
    """
    Send summary to voice notification server (OpenAI TTS endpoint)

    Args:
        summary: The summary text to send
        port: The port of the voice server (from VOICE_SERVER_PORT env var)

    Returns:
        True if successful, False otherwise
    """
    try:
        url = f"http://127.0.0.1:{port}/v1/audio/speech"
        da_name = os.environ.get("DA_NAME", "AI Assistant")
        payload = {
            "model": "tts-1",
            "input": f"{da_name} Task Complete: {summary}",
            "voice": "alloy",
            "response_format": "mp3"
        }

        # Create request with urllib
        req = urllib.request.Request(url, method='POST')
        req.add_header('Content-Type', 'application/json')
        data = json.dumps(payload).encode('utf-8')

        response = urllib.request.urlopen(req, data=data, timeout=10)

        if response.status == 200:
            # Save audio to temp file
            with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
                f.write(response.read())
                audio_file = f.name

            # Play the audio
            played = play_audio(audio_file)

            # Send desktop notification
            try:
                subprocess.run(['notify-send', f'{da_name} Task Complete', summary],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except:
                pass

            # Clean up temp file
            try:
                os.unlink(audio_file)
            except:
                pass

            if played:
                print(f"Sent summary to voice server: {summary}", file=sys.stderr)
                return True
            else:
                print("Audio generated but playback failed", file=sys.stderr)
                return False
        else:
            print(f"Voice server responded with status {response.status}", file=sys.stderr)
            return False

    except urllib.error.HTTPError as e:
        print(f"Voice server error (HTTP {e.code}): {e.reason}", file=sys.stderr)
        return False
    except urllib.error.URLError as e:
        print(f"Could not reach voice server: {e.reason}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error sending to voice server: {e}", file=sys.stderr)
        return False


#########################[ end send_to_voice_server ]########################

#########################[ start main ]######################################
def main():
    """
    Main hook function - handles voice summaries on task completion.

    Flow:
    1. Read JSON payload from stdin
    2. Skip voice summary if in plan mode
    3. Read transcript and generate voice summary
    4. Send to voice server

    Note: Plan exit detection is now handled by PostToolUse hook for ExitPlanMode.
    """
    try:
        # Read JSON payload from stdin
        hook_data = json.load(sys.stdin)

        # Clean orchestration state (first action, non-blocking)
        cwd = hook_data.get('cwd', os.getcwd())
        try:
            subprocess.run(
                ["find", ".claude/orchestration", "-path", "*/state/*.json", "-type", "f", "-delete"],
                cwd=cwd,
                capture_output=True,
                timeout=5,
                check=False
            )
        except Exception as e:
            print(f"[stop-hook] State cleanup failed (continuing): {e}", file=sys.stderr)

        # Get current permission mode
        current_mode = hook_data.get('permission_mode', 'default')

        # Skip voice summary if in plan mode
        if current_mode == "plan":
            return 0

        # Voice summary processing
        transcript_path = hook_data.get('transcript_path')
        if transcript_path:
            assistant_response = read_transcript(transcript_path)
            if assistant_response:
                summary = generate_summary(assistant_response)
                if summary:
                    port = os.environ.get("VOICE_SERVER_PORT", "8001")
                    send_to_voice_server(summary, port)

        return 0

    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON payload: {e}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"Stop hook error: {e}", file=sys.stderr)
        return 0  # Don't fail the hook even if there's an error


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())
