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
