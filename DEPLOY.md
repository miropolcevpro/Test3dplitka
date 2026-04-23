# Photo Pave MVP — Deploy Notes

Version: mvp-iter2.2.187-admin-write-api-foundation
Patch: P17
Base: photo_pave_patch_p16_storage_read_contracts.zip

Changes in this patch:
- Added scene preset admin write API foundation on the client side
- Added auth gate runtime for separate protected Tilda admin page
- Added configurable draft/publish/upload endpoint contract and safe request wrappers
- Added token source resolution (bootstrap, explicit, optional storage/query) without exposing raw token in runtime state
- Added request/response diagnostics state for future admin authoring UI

What is included:
- No public UX changes
- No admin UI yet
- No live write calls unless admin mode and endpoints are explicitly configured

Recommended Tilda admin bootstrap pattern (example):
```html
<script>
window.PhotoPaveAdminBootstrap = {
  enabled: true,
  authToken: "YOUR_ADMIN_TOKEN",
  scenePresetsAdmin: {
    enabled: true,
    apiBase: "https://your-gateway.example/api/",
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
5. In console verify `window.PhotoPaveScenePresetAdmin.describeAdminApiContract()` returns the configured contract.

Notes:
- Write endpoints remain disabled by default until bootstrap/config is provided on the protected Tilda admin page.
- Raw auth token is used only for request headers and is not copied into runtime state.
