# Base Resume (source of truth — read-only)

Place the base resume file(s) here (markdown preferred, e.g. `base.md`).

- The rez skill reads every file in this directory **except this README** as
  the base resume.
- The skill never modifies these files — all tailoring happens in working
  copies exported to `/tmp/resumes/`.
- If this directory contains no resume files, rez stops with an error.
