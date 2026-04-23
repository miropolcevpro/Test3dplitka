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
