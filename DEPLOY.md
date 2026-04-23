# Photo Pave MVP — Deploy Notes

Version: mvp-iter2.2.188-admin-shell-foundation
Patch: P18
Base: photo_pave_patch_p17_admin_write_api_foundation.zip

Changes in this patch:
- Added separate admin shell UI layer for a locked Tilda page
- Added scene list merging draft/published manifests with per-scene status chips
- Added basic authoring panel: refresh catalog, select scene, open resolved/draft/published scene
- Added app bridge methods to apply a loaded scene base into runtime and refresh the editor safely
- Added collapse mode and admin-only shell visibility without changing public UX

What is included:
- Public user flow stays unchanged by default
- Admin shell appears only in admin mode/bootstrap on the protected Tilda page
- No scene create/save UI yet; this patch focuses on shell, scene list, status, and scene opening

Recommended Tilda admin bootstrap pattern (example):
```html
<script>
window.PhotoPaveAdminBootstrap = {
  enabled: true,
  authToken: "YOUR_ADMIN_TOKEN",
  scenePresetsAdmin: {
    enabled: true,
    apiBase: "https://your-gateway.example/api/",
    adminShell: {
      enabled: true,
      autoInit: true
    },
    endpoints: {
      saveSceneDraft: "scene-presets/admin/draft/scene",
      saveVariantDraft: "scene-presets/admin/draft/variant",
      publishScene: "scene-presets/admin/publish/scene",
      publishVariant: "scene-presets/admin/publish/variant",
      uploadAsset: "scene-presets/admin/upload"
    }
  }
};
</script>
```

Deploy:
1. Replace current static bundle with this archive contents.
2. Purge Tilda/GitHub Pages/browser cache.
3. Verify footer build version is updated.
4. Smoke-test existing user flow: photo upload, contour, auto contour, texture switch, export PNG.
5. On the protected Tilda admin page, verify the admin shell appears, loads draft/published scene statuses, and can open a selected scene.

Notes:
- The shell expects scene manifests in the storage structure introduced earlier (draft/published manifests and scene files).
- Scene create/edit/save UI will be added in the next patches; this patch only provides the separate shell and scene-opening workflow.
