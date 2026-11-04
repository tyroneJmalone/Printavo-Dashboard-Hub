# Maintaining the admin updates library

The admin Settings viewer is read-only. Maintain its content alongside the work,
not through a second copy of each proposal.

## Changelog

Edit `docs/hub-changelog.json`. Group user-facing changes into coherent releases
and use New features, Improvements, Fixes, and Admin action needed.

- `prepared`: implemented but no verified publication recorded.
- `published`: use only after publication has been verified; record its actual
  publication date in `date` (YYYY-MM-DD).
- `historical`: backfilled summary with unverified release timing. Leave `date`
  null instead of assigning a guessed deployment date.

Release descriptions are curated and must be updated alongside each implemented
feature or fix. At runtime, the published server presents bundled `prepared`
records as `published` ("Included in published build"). Preview retains the
source status. This confirms inclusion only, not the first publication date:
never substitute today's date, build time, or server startup time for that date.
Historical entries and planning documents are not automatically promoted.
New descriptions and documents still require a build/publish to reach the live app.

Keep entries concise and describe where staff can find the feature and any
required administrator action. Do not include credentials or private tokens.

## Planning documents

`docs/admin-planning-index.json` is an explicit allowlist of source Markdown
documents. The API build embeds those original files in the server bundle, so
production does not depend on the repository's docs directory at runtime.
Missing documents fail the build. The API is administrator-only; these documents
must never be copied to the frontend public directory.

The index holds title, summary, status and `updatedOn`. Use the date of a known
substantive document update, not a build date or filesystem modification time.
For legacy documents without a verified last-update date, keep it null; the UI
shows that the date was not recorded. Update this metadata when editing plans.

Idea, Planned, In progress, Needs verification and Deferred are supported.
Do not convert a deferred proposal to approved work just because it is listed.
The historical roadmap has mixed completion claims and is labeled Needs
verification rather than presented as a current release inventory.
