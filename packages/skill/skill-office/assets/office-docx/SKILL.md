---
name: office-docx
description: Create, read, edit, and validate Word documents (.docx).
---

# Word documents

Use `python-docx` for DOCX creation and ordinary edits. Follow an explicit user or applicable AGENTS.md requirement for a project environment or another library. Otherwise call `load_workspace_dependencies` and execute the returned Python path with its bundled libraries. Do not install packages or discover a system Python for the default workflow. If the tool is unavailable, use an already configured environment and report a missing dependency only when it prevents the requested operation.

Keep source scripts, intermediate files, and final documents in the task workspace; the runtime and this skill directory are read-only resources. Use the user's requested language and preserve an existing document's design unless a redesign is requested.

Name Python scripts for their task, such as `edit_docx.py`; avoid module names such as `inspect.py`, `docx.py`, or `zipfile.py` that shadow imported libraries.

## Create and edit

For text edits, locate the target by its text or position and inspect only its runs and formatting. A title can be an ordinary paragraph without a Title style or document-property title. Update the relevant runs; assigning paragraph `.text` destroys run formatting. Save a new file unless an in-place edit is requested. Read other structures only when the edit involves them; rebuilding a document can lose unsupported features.

Use paragraph styles for headings and body text. Size tables for the section that contains them, and account for merged cells and nested tables. Chinese, Japanese, and Korean text may need an explicit `w:eastAsia` font assignment in addition to `run.font.name`; font names alone do not establish glyph availability or rendered appearance.

python-docx does not paginate or render documents. Do not represent ordinary replacement, colored text, or comments as tracked changes. When real revisions or unsupported OOXML features matter, preserve their package parts and verify the requested operation rather than silently discarding them.

## Check and deliver

Use the full loaded skill result, including `resourceBase.path`, for script paths. In PTC, print or return the full result rather than only `.content`. Run the shared Python checker once per saved version; `<skill-directory>` is that resource path. Do not search other directories for the checker. In PowerShell, prefix the quoted Python executable with `&`.

```text
"<python>" "<skill-directory>/../scripts/check_office.py" <document.docx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships, and reports paragraphs, logical table dimensions, and sections. Optional `--contains TEXT` arguments assert required text. A successful structural check does not verify pagination, clipping, fonts, or visual appearance. Compare the summary and reopened document with the user's request, including unchanged content that matters to an edit.

For routine text edits, the shared checker and targeted content/formatting verification are sufficient; deliver when both pass. Do not dump or unpack OOXML, enumerate styles, inspect document properties, or compare whole packages for reassurance. Use package-level investigation only for a concrete validation failure, ambiguous edit target, unsupported feature, or explicit user requirement. Repair script/import errors before continuing. If the checker cannot run, report the structural-validation limit.

Creating a file or changing content with incidental basic formatting does not require additional operations. Load `office-render` for requested images or visual inspection. When styling, font color, spacing, sizing, or text alignment is the requested edit, load `office-render` and inspect the changed page even without a separate visual-check request, unless the user explicitly skips rendering. For PDF output load `office-export-pdf`.

Call `present({"files":[{"path":"report.docx"}]})` with the actual final DOCX path. It exposes the current source file without copying or preserving its bytes, so keep that file in place and do not present temporary QA reports unless requested. If `present` is unavailable, provide the final workspace path using the session's supported file delivery method.
