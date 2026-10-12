---
kind: upgrade-guide
description: "Bundled Office resources no longer provide the check_office.py command."
---

# Office checker removal

English | [中文](guide.zh.md)

## Change

Office resources no longer include `scripts/check_office.py`. Custom skills and scripts that invoke this helper must update. Authoring skills verify saved documents through their Python libraries; the provider no longer requires a shared scripts directory. Rendering, recalculation, and PDF export remain separate operations.

## Migration

1. Remove calls to `check_office.py` from custom Office workflows.
2. Reopen saved files with python-docx, python-pptx, or openpyxl and verify the requested content, formatting, and preserved data. These checks do not provide a package-integrity report.
3. Run the workflow and confirm that the requested edits survive reopening. Request rendering or recalculation when the task needs those operations.
