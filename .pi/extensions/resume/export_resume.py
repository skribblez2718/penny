#!/usr/bin/env python3
"""
Export markdown resume to .docx using word_doc_gen.py.

Usage: python3 export_resume.py <markdown_path> <output_path>

Called by the resume extension's resume_export tool.
"""
import sys
import os

# Add project root to path for word_doc_gen import
PROJECT_ROOT = os.environ.get("PROJECT_ROOT", os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts", "tools"))

from word_doc_gen import generate_resume_docx


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <markdown_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    markdown_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.isfile(markdown_path):
        print(f"Error: markdown file not found: {markdown_path}", file=sys.stderr)
        sys.exit(1)

    result = generate_resume_docx(markdown_path, output_path)
    print(result)


if __name__ == "__main__":
    main()
