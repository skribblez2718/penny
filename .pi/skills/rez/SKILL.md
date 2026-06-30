---
name: rez
description: "Manage and export professional resume. Use for resume updates, accomplishment tracking, and document generation. Do not use for full job search automation or cover letter generation."
license: MIT
metadata:
  version: "0.1.0"
  penny:
    state_machine: false
    mempalace: false
---

# rez Skill

Manage and export your professional resume.

## When to Use

- Updating your resume with new accomplishments
- Exporting your resume to .docx format
- Reviewing your STAR-format accomplishments pool

## When NOT to Use

- Full job search automation (archived)
- Cover letter generation (archived)

## Resources

| File | Purpose |
|------|---------|
| `resources/resume.md` | Canonical markdown resume |
| `resources/accomplishments.md` | STAR-format accomplishments pool |

## Tools

Uses the `resume` extension tools:
- `resume_export` — convert markdown resume to .docx
- `resume_list_accomplishments` — query the accomplishments pool
- `resume_update_canonical` — add bullets to resume or accomplishments
