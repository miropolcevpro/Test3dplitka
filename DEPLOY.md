Deploy — P18.1 admin no-auth separation hotfix

Public frontend
1. Deploy the full bundle as usual.
2. Public site should use index.html.
3. Verify that public UI does not contain the admin shell block.

Admin page
1. Upload the same full bundle to a protected path, for example /admin3d/.
2. Open /admin3d/admin.html directly, or embed it in a protected Tilda page via iframe.
3. admin.html already includes a no-token bootstrap:
   - enabled: true
   - scenePresetsAdmin.enabled: true
   - requireAuth: false
   - adminShell.enabled: true
4. This mode is read-only until write API endpoints are configured in later patches.

Recommended Tilda embed
Use an iframe that points to /admin3d/admin.html inside a password-protected Tilda page.
