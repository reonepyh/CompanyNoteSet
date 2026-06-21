# Attachment Organizer

Obsidian plugin that organizes non-Markdown attachment files from a notes folder into one vault-local attachments folder.

## Behavior

- Runs only when the user executes the command.
- Command: `첨부파일 정리 실행`
- Optional startup and interval-based automatic runs can be enabled in settings.
- Interval-based automatic runs wait one full interval before the first run.
- Automatic runs skip if another cleanup is already running.
- `.md` files are not moved.
- Hidden files and temporary files are ignored.
- The attachments folder must be inside the vault.
- The notes folder and attachments folder cannot be the same folder or nested inside each other.
- File mode uses the representative Markdown file in the same folder as each attachment.
- Folder bundle mode uses the representative Markdown file in the parent folder of each `_att_...` bundle folder.
- The representative file is selected by a user-configured frontmatter field.
- Empty representative document number fields can be filled from a configurable format.
- Missing created/modified frontmatter fields can be filled from file timestamps.
- The created/modified field names and date format are configurable.
- Attachments are renamed as `{documentNo}-{attachmentNo5}.{extension}`.
- Original filenames are not included.
- Compound extensions are preserved.
- File mode keeps the existing per-file rename policy.
- Folder bundle mode moves `_att_...` folders as one attachment bundle.
- Folder bundle mode renames the folder to `{documentNo}-{attachmentNo5}` and keeps inner filenames unchanged.
- Each successful rename is appended to a table in the representative Markdown file.
- If an Asset web base URL is configured, each successful rename is also added to a folded Asset link callout in the representative Markdown file.
- Asset link labels use the original file or folder name.
- Existing Asset link callouts keep their current content; missing links are appended from the attachment history table.
- A separate command can rebuild Asset link callouts from the attachment history table.
- Markdown files with invalid frontmatter are logged as needs-action items and do not stop the whole run.
- Markdown links are not automatically updated.
- Needs-action items are logged in plugin data and in `작업필요.md` at the vault root.

## Install Manually

Copy this folder into:

```text
<vault>/.obsidian/plugins/attachment-mirroring/
```

Then enable `Attachment Organizer` in Obsidian community plugins.
