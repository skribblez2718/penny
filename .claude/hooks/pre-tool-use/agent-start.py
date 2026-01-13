"""
PreToolUse hook - Notifies when agents start
Detects Task tool calls and sends agent start notifications to voice server
"""

import sys
import os
import json
import urllib.request
import urllib.error
import tempfile
import subprocess
import re
from typing import Optional


#########################[ start generate_task_summary ]#####################
def generate_task_summary(prompt: str, description: str = None) -> str:
    """
    Generate a one-sentence task summary

    Args:
        prompt: The full task prompt
        description: Optional description parameter from Task tool

    Returns:
        One-sentence summary of the task
    """
    # If description parameter exists, use it
    if description:
        # Truncate to first sentence or 100 chars
        first_sentence = re.split(r'[.!?]', description)[0].strip()
        return first_sentence[:100]

    # Otherwise, extract from prompt
    # Try to get first line or first 100 characters
    if not prompt:
        return "Starting task"

    # Clean up the prompt
    prompt = prompt.strip()

    # Try to extract first sentence
    first_sentence = re.split(r'[.!?\n]', prompt)[0].strip()

    # Truncate to reasonable length
    if len(first_sentence) > 100:
        return first_sentence[:97] + "..."

    return first_sentence if first_sentence else "Starting task"


#########################[ end generate_task_summary ]#######################

#########################[ start play_audio ]################################
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
def send_to_voice_server(agent_name: str, task_summary: str, port: str = "8001") -> bool:
    """
    Send agent start notification to voice server (OpenAI TTS endpoint)

    Args:
        agent_name: The name of the agent starting
        task_summary: One-sentence summary of the task
        port: The port of the voice server (from VOICE_SERVER_PORT env var)

    Returns:
        True if successful, False otherwise
    """
    try:
        url = f"http://127.0.0.1:{port}/v1/audio/speech"

        # Format agent name for display
        display_name = agent_name.capitalize()

        payload = {
            "model": "tts-1",
            "input": f"{display_name} Agent Starting: {task_summary}",
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
                subprocess.run(['notify-send', f'{display_name} Agent Starting', task_summary],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except:
                pass

            # Clean up temp file
            try:
                os.unlink(audio_file)
            except:
                pass

            if played:
                print(f"✅ Sent agent start notification: {display_name} - {task_summary}", file=sys.stderr)
                return True
            else:
                print(f"⚠️  Audio generated but playback failed", file=sys.stderr)
                return False
        else:
            print(f"⚠️  Voice server responded with status {response.status}", file=sys.stderr)
            return False

    except urllib.error.HTTPError as e:
        print(f"⚠️  Voice server error (HTTP {e.code}): {e.reason}", file=sys.stderr)
        return False
    except urllib.error.URLError as e:
        print(f"⚠️  Could not reach voice server: {e.reason}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"❌ Error sending to voice server: {e}", file=sys.stderr)
        return False


#########################[ end send_to_voice_server ]########################

#########################[ start main ]######################################
def main():
    """
    Main hook function
    Detects Task tool calls and sends agent start notifications
    """
    try:
        # Read JSON payload from stdin
        hook_data = json.load(sys.stdin)

        # DEBUG: Log hook firing
        print("🔍 Agent start hook fired", file=sys.stderr)
        print(f"🔍 Hook event: {hook_data.get('hook_event_name')}", file=sys.stderr)

        # Check if this is a Task tool call
        tool_name = hook_data.get('tool_name', '')
        print(f"🔍 Tool name: {tool_name}", file=sys.stderr)

        if tool_name != 'Task':
            # Not a Task tool, exit silently
            print(f"🔍 Not a Task tool, exiting silently", file=sys.stderr)
            return 0

        # Extract tool input
        tool_input = hook_data.get('tool_input', {})
        if not tool_input:
            print(f"⚠️  No tool_input in hook data", file=sys.stderr)
            return 0

        # Extract agent type
        agent_name = tool_input.get('subagent_type', 'Unknown')
        print(f"🔍 Agent type: {agent_name}", file=sys.stderr)

        # Extract task prompt and description
        prompt = tool_input.get('prompt', '')
        description = tool_input.get('description', '')

        # Generate task summary
        task_summary = generate_task_summary(prompt, description)

        # Get voice server port from environment
        port = os.environ.get("VOICE_SERVER_PORT", "8001")
        print(f"🔍 Voice server port: {port}", file=sys.stderr)

        # Send to voice server
        success = send_to_voice_server(agent_name, task_summary, port)
        print(f"🔍 Voice notification sent: {success}", file=sys.stderr)

        return 0

    except json.JSONDecodeError as e:
        print(f"❌ Failed to parse JSON payload: {e}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"❌ Agent start hook error: {e}", file=sys.stderr)
        return 0  # Don't fail the hook even if there's an error


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())
