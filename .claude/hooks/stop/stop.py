"""
Stop hook - Sends task summary to voice notification server
Reads JSON payload, parses transcript file, and extracts SUMMARY section
"""

import sys
import os
import re
import json
import urllib.request
import urllib.error
import tempfile
import subprocess
from typing import Optional
from pathlib import Path


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
            print(f"⚠️  Transcript file not found: {transcript_path}", file=sys.stderr)
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
        print(f"❌ Error reading transcript: {e}", file=sys.stderr)
        return None


#########################[ end read_transcript ]#############################

#########################[ start extract_da_sections ]#######################
def extract_da_sections(text: str) -> dict:
    """
    Extract sections from DA.md formatted response

    Args:
        text: The full response text from Penny

    Returns:
        Dictionary with extracted sections
    """
    sections = {}

    # Define section markers
    markers = {
        'summary': r'📋 SUMMARY:\s*(.+?)(?=\n\s*[📋🔍⚡✅📊➡️🎯]|\n\n|$)',
        'analysis': r'🔍 ANALYSIS:\s*(.+?)(?=\n\s*[📋🔍⚡✅📊➡️🎯]|\n\n|$)',
        'actions': r'⚡ ACTIONS:\s*(.+?)(?=\n\s*[📋🔍⚡✅📊➡️🎯]|\n\n|$)',
        'results': r'✅ RESULTS:\s*(.+?)(?=\n\s*[📋🔍⚡✅📊➡️🎯]|\n\n|$)',
        'status': r'📊 STATUS:\s*(.+?)(?=\n\s*[📋🔍⚡✅📊➡️🎯]|\n\n|$)',
        'next': r'➡️ NEXT:\s*(.+?)(?=\n\s*[📋🔍⚡✅📊➡️🎯]|\n\n|$)',
        'completed': r'🎯 COMPLETED:\s*(.+?)(?=\n|$)',
    }

    for key, pattern in markers.items():
        match = re.search(pattern, text, re.DOTALL | re.MULTILINE)
        if match:
            sections[key] = match.group(1).strip()

    return sections


#########################[ end extract_da_sections ]#########################

#########################[ start generate_summary ]##########################
def generate_summary(text: str) -> Optional[str]:
    """
    Generate intelligent 2-3 sentence voice summary from assistant response

    Strategy:
    1. Check for custom voice marker (🗣️ CUSTOM COMPLETED:)
    2. Extract DA.md sections and create natural summary
    3. Fallback to first few sentences

    Args:
        text: The full response text from Penny

    Returns:
        2-3 sentence voice-optimized summary, None if text is empty
    """
    if not text or not text.strip():
        return None

    text = text.strip()

    # Priority 1: Custom voice markers (user explicitly defined voice summary)
    voice_markers = ['🗣️ CUSTOM COMPLETED:', 'CUSTOM COMPLETED:']
    for marker in voice_markers:
        if marker in text:
            idx = text.index(marker) + len(marker)
            summary = text[idx:].split('\n')[0].strip()
            return summary

    # Priority 2: Extract and combine DA.md sections
    sections = extract_da_sections(text)

    if sections:
        # Build voice summary from key sections
        parts = []

        # Start with what was completed
        if 'completed' in sections:
            completed = sections['completed'].strip()
            # Remove "Completed" prefix if present
            completed = re.sub(r'^Completed\s+', '', completed, flags=re.IGNORECASE)
            parts.append(completed)
        elif 'summary' in sections:
            # Use summary if no completed section
            summary_text = sections['summary'].strip()
            # Take first sentence only
            first_sentence = re.split(r'(?<=[.!?])\s+', summary_text)[0]
            parts.append(first_sentence)

        # Add key result if available (1 sentence max)
        if 'results' in sections:
            results = sections['results'].strip()
            # Extract first concrete result (look for bullet points or sentences)
            result_lines = [line.strip() for line in results.split('\n') if line.strip()]
            if result_lines:
                first_result = result_lines[0]
                # Clean up markdown and emoji
                first_result = re.sub(r'^[-*•]\s*', '', first_result)
                first_result = re.sub(r'^[✅❌⚠️🔍📋⚡]+\s*', '', first_result)
                # Take first sentence
                first_sentence = re.split(r'(?<=[.!?])\s+', first_result)[0]
                if len(first_sentence.split()) <= 20:  # Keep it concise
                    parts.append(first_sentence)

        if parts:
            summary = '. '.join(parts)
            # Ensure it ends with period
            if not summary.endswith('.'):
                summary += '.'
            return summary

    # Priority 3: Extract first 2-3 sentences from raw text
    # Remove all markdown and emoji
    cleaned = re.sub(r'[#*`]', '', text)
    cleaned = re.sub(r'[\U0001F300-\U0001F9FF\u2600-\u26FF\u2700-\u27BF]+', '', cleaned)

    # Split into sentences
    sentences = re.split(r'(?<=[.!?])\s+', cleaned.strip())

    # Take first 2-3 non-empty sentences
    summary_sentences = []
    for sentence in sentences[:3]:
        sentence = sentence.strip()
        if sentence and len(sentence.split()) >= 3:  # Meaningful sentence
            summary_sentences.append(sentence)
            if len(summary_sentences) == 2:  # Max 2 sentences for voice
                break

    if summary_sentences:
        return ' '.join(summary_sentences)

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
        payload = {
            "model": "tts-1",
            "input": f"Penny Task Complete: {summary}",
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
                subprocess.run(['notify-send', 'Penny Task Complete', summary],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except:
                pass

            # Clean up temp file
            try:
                os.unlink(audio_file)
            except:
                pass

            if played:
                print(f"✅ Sent summary to voice server: {summary}", file=sys.stderr)
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
    Reads JSON payload from stdin, parses transcript, and sends summary to voice server
    """
    try:
        # Read JSON payload from stdin
        hook_data = json.load(sys.stdin)

        # Extract transcript path from payload
        transcript_path = hook_data.get('transcript_path')
        if not transcript_path:
            print("⚠️  No transcript_path in hook payload", file=sys.stderr)
            return 0

        # Read the transcript file
        assistant_response = read_transcript(transcript_path)
        if not assistant_response:
            return 0

        # Generate the summary
        summary = generate_summary(assistant_response)
        if not summary:
            # No summary found, exit silently
            return 0

        # Get voice server port from environment
        port = os.environ.get("VOICE_SERVER_PORT", "8001")

        # Send to voice server
        send_to_voice_server(summary, port)

        return 0

    except json.JSONDecodeError as e:
        print(f"❌ Failed to parse JSON payload: {e}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"❌ Stop hook error: {e}", file=sys.stderr)
        return 0  # Don't fail the hook even if there's an error


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())
