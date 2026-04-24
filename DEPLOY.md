Deploy — P18.2 GitHub/Tilda admin hosting hotfix

Public frontend
1. Deploy the full bundle to the repository root as usual.
2. Public site should keep using index.html from the repository root.
3. Verify that public UI does not contain the admin shell block.

GitHub-hosted admin bundle
1. Keep the new folder /photo-pave-admin/ in the repository.
2. It contains a full self-contained admin bundle with relative asset paths.
3. Open https://YOUR-DOMAIN/photo-pave-admin/admin.html directly to verify it loads.
4. You may also open https://YOUR-DOMAIN/photo-pave-admin/ because index.html is duplicated there.

Tilda admin page
1. Keep the protected Tilda page at /admin3d/.
2. Do not point the iframe to /admin3d/admin.html because /admin3d/ is the Tilda page itself, not a GitHub Pages folder.
3. Embed the GitHub-hosted bundle URL /photo-pave-admin/admin.html inside the Tilda page via iframe.

Ready Tilda embed
Use the contents of TILDA_ADMIN_EMBED.html.


P19 deployment notes:
- Public root stays unchanged.
- Admin page is hosted from /photo-pave-admin/admin.html on GitHub Pages.
- For Tilda use the iframe snippet from TILDA_ADMIN_EMBED.html (GitHub Pages URL, not ag-ru.com/admin3d/admin.html).
- Scene authoring in admin shell now supports local drafts via browser storage and scene.json export/import; backend write API is still optional for later patches.


P20 deployment notes:
- Public root stays unchanged and should still be free of admin shell.
- GitHub-hosted admin bundle remains /photo-pave-admin/admin.html.
- Admin shell now includes a dedicated geometry panel with readiness summary and quick actions for contour/cutout/view/reset.
- Base scene capture now blocks incomplete geometry (no photo, open contour, or fewer than 3 points).
- Update the Tilda iframe URL query to iter2_2_192_p20_geometry.


## Patch P21 — variant authoring foundation
- Updated admin shell with local variant draft workflow.
- GitHub Pages admin entrypoint remains `photo-pave-admin/admin.html`.
- After deploy, hard refresh admin page if browser cache is sticky.


## Patch P21.1 — admin layout height hotfix
- Admin entrypoints now allow full vertical scroll and are no longer hard-clipped to the viewport.
- Public layout and runtime logic are unchanged.
- Update Tilda iframe src query version after deploy.


## Patch P22 — repo-ready scene package export
- Admin can export a zip package with `preset-scenes/published/<sceneId>/scene.json`, `variants.json`, all `variants/*.json`, and manifest helper files.
- Workflow: create base scene -> save local draft -> save local variants per texture -> export repo package -> replace files in repo -> push GitHub Pages.


## Patch P23 — published manifest helper UI
- Admin UI now shows repo paths, manifest entry preview and deploy instructions for exported scene packages.
- Tilda iframe URL query version updated to iter2_2_196_p23_manifest_helper.


## Patch P24 — public ready-scene foundation
- Public frontend can read published scene manifest from repo structure.
- Ready scenes panel is safe: if manifest is absent, old upload flow stays intact.
- Admin iframe code does not need to change for this patch.


## Patch P25 — public showroom UX
- Published scenes become the first public scenario when manifest exists.
- User can still switch to uploading their own photo through a dedicated CTA.
- Hard refresh after deploy if GitHub Pages cache is sticky.


## Patch P26 — exact published variant polish
- Public showroom now explicitly indicates whether an exact published variant was found or whether scene fallback remains active.
- Hard refresh the public site after deploy to avoid stale JS/CSS from cache.


## Patch P27 — published scenes production hardening
- Public showroom now filters invalid scene entries, times out stalled scene/variant opens and caches missing exact variants to reduce repeated 404 requests.
- If a scene is broken, showroom suggests choosing another scene or switching to own-photo mode without collapsing the public flow.
- Hard refresh after deploy to avoid stale JS/CSS from cache.


## Patch P28 — showroom conversion polish
- Public ready-scene showroom gets stronger conversion copy and cleaner CTA labels.
- No admin flow changes.
- After deploy, hard refresh public page and Tilda iframe if cached.


## Patch P29 — published asset/photo hardening
- Public ready scenes now load published scene photo asset on open.
- Broken preview/photo URLs are cached to reduce repeated failing requests.
- Hard refresh public after deploy if cache is sticky.


## Patch P30 — published repo structure autofill in admin
- Added helper panel for GitHub Pages base URL and filename templates.
- Admin can autofill scene photo/thumb/cover URLs and preview URL for all local variants before exporting repo package.
- Update Tilda iframe query version after deploy.


## P30.1 hotfix
- Published variant filenames/previews now use slugified stems consistent with variant keys.
- Scene autofill now autosaves local draft immediately.
- Repo package export is blocked until sceneId, base scene, at least one variant and photo URL are present; preview URL remains warning-only.


## Patch P31 — published scene package validation
- Added validation UI in admin helper before repo package export.
- Shows blockers, warnings, duplicate publish filename conflicts and preview gaps.
- Export remains blocked until required checks pass.


## Patch P32 — bulk asset import helper
- Admin shell can parse a pasted list of asset URLs/paths and apply matches to scene photo/thumb/cover and variant preview URLs.


## Patch P33 — published package export polish
- Admin helper now previews package composition and zip includes richer service files for publication.
- Update Tilda iframe query version after deploy to bypass cache.
