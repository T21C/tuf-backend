# Mod release ZIP URLs

Implemented on `feat/mod-zip-url`, based on `dev`. Run migration
`1791115200_mod_release_zip_urls.cjs` before deploying the backend. It adds nullable
`githubUrl` and `platformDownloadUrls` columns to `mod_versions`; existing release
URLs remain unchanged. The fresh local development schema already has these
columns; existing deployment databases still need this migration.

Both admin and assigned-developer release create/update routes accept:

- `downloadUrl`: one HTTPS URL with a `.zip` pathname, or an empty string for a
  platform-only release.
- `platformDownloadUrls`: an object with optional `windows`, `macos`, and `linux`
  ZIP URLs. `null` clears the map; supplying an object replaces the map.
- `githubUrl`: optional GitHub release provenance. A legacy request containing
  only this field resolves release assets, or preserves an exact asset URL.

At least one common or platform URL is required. Partial updates preserve omitted
fields. Hosted ZIP uploads remain mutually exclusive with external ZIP fields,
and their source remains read-only. Release responses expose both new fields.

`POST /v2/admin/mods/{id}/github-release-assets` and
`POST /v2/developers/mods/{id}/github-release-assets` accept `{ githubUrl }` under
the same editing permissions as releases. They return ZIP assets, their inferred
platforms, and suggested URLs. Developer cookie requests require CSRF. Only the
fixed GitHub API host is fetched, with a timeout and response size limit.

Detection recognizes Windows/Win32/Win64, macOS/Mac/OSX/Darwin, and Linux/Ubuntu
filename tokens. Source/debug/symbol files and mixed-platform names are not
suggested. Multiple ZIPs for the same platform are left for manual selection.
GitHub-generated source archives are not release assets and are not considered.
Asset URLs follow the [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)
`browser_download_url` field.

Both `/v2/mods/{slug}/download` and
`/v2/mods/{slug}/{version}/download` accept `?platform=windows|macos|linux`.
Platform ZIPs take precedence over the common ZIP. Unknown query values return
400; unavailable platforms return 404. A release without a common ZIP requires a
platform query and returns 400 without one; it never guesses another OS.

The web frontend detects desktop OS for catalog downloads and shows explicit
platform download buttons on mod detail/release pages. Other API clients should
send their target platform when downloading platform-only releases.

Validation completed: backend TypeScript check, security lint, 76 mod tests;
frontend changed-file lint, 4 ZIP form tests, and Vite development-mode build.
The migration was smoke-tested with a mock query interface (up, idempotent rerun,
down). The live TUFHelper v3.1.1 GitHub release returned Windows, OSX, and Linux ZIP
assets. Authenticated UI-to-database saving was verified with the local developer
fixture. All 15 non-empty common/platform URL combinations passed 120 latest/version
download checks. A concurrent download-counting deadlock was fixed in the
non-transactional MySQL path; 24 simultaneous requests incremented the count once.

The local-only init/seed scripts refuse non-development or non-loopback databases.
The case seeder assigns its fixtures to `modziptest` and preserves subsequent edits.
They are optional test tooling, not deployment steps.
