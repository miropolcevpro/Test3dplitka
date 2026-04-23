window.PhotoPaveReleaseConfig=(function(){
  const preset = "public-core";
  const patch = "P09-HF2";
  const currentOrigin = (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin.replace(/\/$/,"") : "";
  const DEFAULT_GATEWAY = "https://d5d1712p9mu7k3aurh9s.laqt4bj7.apigw.yandexcloud.net";
  const features = {
    advancedPanel: {
      label:"Дополнительные настройки",
      enabled:true,
      visible:true,
      stage:"advanced"
    },
    simpleModeShell: {
      label:"Guided simple mode shell",
      enabled:true,
      visible:true,
      stage:"public"
    },
    secondaryTools: {
      label:"Дополнительные инструменты",
      enabled:true,
      visible:true,
      stage:"advanced"
    },
    contourAssist: {
      label:"Contour UX assist",
      enabled:true,
      visible:true,
      stage:"public"
    },
    ultra: {
      label:"Premium Ultra",
      enabled:true,
      visible:true,
      stage:"advanced"
    },
    occlusion: {
      label:"Перекрытия объектов",
      enabled:false,
      visible:false,
      stage:"disabled",
      reason:"Временно скрыто из публичного релиз-контура до отдельного стабилизационного патча."
    },
    calib3d: {
      label:"3D-калибровка перспективы",
      enabled:false,
      visible:false,
      stage:"disabled",
      reason:"Beta-функция выведена из публичного релиз-контура до отдельного hardening-патча."
    },
    multiZone: {
      label:"Мультизональность",
      enabled:false,
      visible:false,
      stage:"disabled",
      reason:"Публичный релиз зафиксирован в single-zone режиме."
    },
    splitZone: {
      label:"Подзоны / split zone",
      enabled:false,
      visible:false,
      stage:"disabled",
      reason:"Зависит от мультизональности и исключено из публичного релиз-контура."
    },
    aiDebugOverlay: {
      label:"AI debug overlay",
      enabled:false,
      visible:false,
      stage:"disabled",
      reason:"Dev-only overlay выключен в публичной сборке."
    },
    debugMetrics: {
      label:"Debug metrics overlay",
      enabled:false,
      visible:false,
      stage:"disabled",
      reason:"Dev-only diagnostics выключены в публичной сборке."
    },
    devUrlFlags: {
      label:"Dev URL flags",
      enabled:false,
      visible:false,
      stage:"disabled",
      reason:"Экспериментальные URL-флаги выключены в публичной сборке."
    }
  };



  const assetDelivery = {
    stage:"hardening",
    strictStaticShapes:true,
    preferLocalAiRuntime:true,
    allowRemoteAiRuntime:true,
    allowApiPaletteFallback:false,
    allowLegacyGithubShapesFallback:false,
    requireCorsForTextures:true,
    allowNoCorsImageFallback:false,
    shapesCandidates:[
      "shapes.json",
      "data/shapes.json",
      "frontend_github_pages/shapes.json"
    ],
    allowedOrigins:{
      json:[currentOrigin, DEFAULT_GATEWAY, "https://storage.yandexcloud.net"],
      image:[currentOrigin, "https://storage.yandexcloud.net"],
      model:[currentOrigin, "https://storage.yandexcloud.net", "https://storage.googleapis.com"],
      script:[currentOrigin, "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://docs.opencv.org"],
      wasm:[currentOrigin, "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"]
    }
  };

  function _toAbsUrl(url){
    try{ return new URL(url, window.location.href).toString(); }catch(_){ return String(url||""); }
  }
  function _originOf(url){
    try{ return new URL(_toAbsUrl(url)).origin.replace(/\/$/,""); }catch(_){ return ""; }
  }
  function getAllowedOrigins(kind){
    const groups = assetDelivery && assetDelivery.allowedOrigins ? assetDelivery.allowedOrigins : null;
    const arr = groups && groups[kind] ? groups[kind] : [];
    return arr.filter(Boolean).map((v)=>String(v).replace(/\/$/,""));
  }
  function isAssetAllowed(url, kind){
    if(!url || typeof url !== "string") return false;
    const abs = _toAbsUrl(url);
    const origin = _originOf(abs);
    if(!origin) return false;
    const allowed = getAllowedOrigins(kind);
    if(!allowed.length) return true;
    return allowed.includes(origin);
  }

  const analytics = {
    stage:"foundation",
    enabled:true,
    transportMode:"local_queue",
    endpoint:null,
    storageKey:"pp_analytics_queue_v1",
    maxRecent:80,
    maxQueue:200,
    events:[
      "photo_upload_started",
      "photo_upload_success",
      "contour_started",
      "contour_completed",
      "cutout_started",
      "texture_selected",
      "compare_opened",
      "export_clicked",
      "export_success",
      "advanced_mode_opened",
      "render_error"
    ]
  };

  const capabilityMatrix = {
    stage:"graceful-degradation",
    tiers:{
      safe:{
        label:"Safe",
        ultraVisible:true,
        ultraAllowed:false,
        ultraDefault:false,
        runDepth:false,
        quality:"basic",
        preferProvider:"none",
        maxInputLongSide:0,
        exportScale:0.85
      },
      reduced:{
        label:"Reduced",
        ultraVisible:true,
        ultraAllowed:true,
        ultraDefault:false,
        runDepth:true,
        quality:"balanced",
        preferProvider:"auto",
        maxInputLongSide:224,
        exportScale:0.92
      },
      full:{
        label:"Full",
        ultraVisible:true,
        ultraAllowed:true,
        ultraDefault:true,
        runDepth:true,
        quality:"ultra",
        preferProvider:"auto",
        maxInputLongSide:336,
        exportScale:1.0
      }
    },
    thresholds:{
      lowMemGb:4,
      midMemGb:6,
      highMemGb:8,
      lowCores:4,
      highCores:8,
      largePhotoMp:9,
      hugePhotoMp:14
    }
  };

  function _num(v){
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function resolveCapabilityProfile(env){
    const t = capabilityMatrix.thresholds || {};
    const mem = _num(env && env.mem);
    const cores = _num(env && env.cores);
    const photoMp = _num(env && env.photoMp) || 0;
    const webgpu = !!(env && env.webgpu);
    const webgl2 = !!(!(env && env.webgl2 === false));
    const reducedMotion = !!(env && env.reducedMotion);
    const isTouch = !!(env && env.isTouch);
    const reasons = [];
    let score = 0;

    if(!webgl2){
      reasons.push("no_webgl2");
      return Object.assign({ tier:"safe", reasonCode:"no_webgl2", reason:"Устройство не прошло WebGL2-проверку. Включён безопасный базовый режим." }, capabilityMatrix.tiers.safe);
    }

    if(webgpu) score += 2;
    else score -= 1;

    if(mem != null){
      if(mem >= (t.highMemGb || 8)) score += 2;
      else if(mem >= (t.midMemGb || 6)) score += 1;
      else if(mem <= (t.lowMemGb || 4)){
        score -= 2;
        reasons.push("low_memory");
      }
    }

    if(cores != null){
      if(cores >= (t.highCores || 8)) score += 1;
      else if(cores <= (t.lowCores || 4)){
        score -= 1;
        reasons.push("low_cpu");
      }
    }

    if(photoMp >= (t.hugePhotoMp || 14)){
      score -= 2;
      reasons.push("huge_photo");
    }else if(photoMp >= (t.largePhotoMp || 9)){
      score -= 1;
      reasons.push("large_photo");
    }

    if(isTouch) score -= 1;
    if(reducedMotion) score -= 1;

    let tier = "reduced";
    if(score >= 3 && webgpu) tier = "full";
    else if(score <= -1) tier = "safe";

    let reasonCode = reasons[0] || "balanced";
    let reason = "Устройство подходит для стандартного release-профиля.";
    if(tier === "full"){
      reasonCode = "full_ready";
      reason = "Доступен полный профиль Ultra без упрощений.";
    }else if(tier === "reduced"){
      reasonCode = reasons[0] || (!webgpu ? "no_webgpu" : "balanced");
      if(reasonCode === "large_photo") reason = "Большая фотография: включён облегчённый профиль Ultra без агрессивной нагрузки.";
      else if(reasonCode === "no_webgpu") reason = "WebGPU недоступен: включён облегчённый профиль с мягкой деградацией.";
      else if(reasonCode === "low_cpu") reason = "Производительность CPU ограничена: включён облегчённый профиль Ultra.";
      else reason = "Включён облегчённый профиль для стабильной работы на массовых устройствах.";
    }else{
      if(reasonCode === "huge_photo") reason = "Очень большая фотография: Ultra автоматически отключён ради стабильности.";
      else if(reasonCode === "low_memory") reason = "Недостаточно доступной памяти: продукт переведён в безопасный базовый режим.";
      else if(reasonCode === "low_cpu") reason = "Слабое устройство: Ultra отключён ради стабильной работы.";
      else reason = "Включён безопасный базовый режим без тяжёлых AI-операций.";
    }

    return Object.assign({ tier, reasonCode, reason }, capabilityMatrix.tiers[tier]);
  }

  const simpleMode = {
    stage:"guided-shell",
    enabled:true,
    defaultShellMode:"simple",
    defaultSecondaryToolsOpen:false,
    steps:[
      { id:"photo", label:"1 Фото" },
      { id:"zone", label:"2 Зона" },
      { id:"tile", label:"3 Плитка" },
      { id:"result", label:"4 Результат" }
    ]
  };

  const inventory = {
    publicCore:[
      "photo-upload",
      "single-zone contour",
      "cutouts",
      "shape catalog",
      "texture catalog",
      "tiling/material base controls",
      "fullscreen viewer",
      "PNG export",
      "share actions"
    ],
    advancedOnly:[
      "Premium Ultra"
    ],
    disabledInPublic:[
      "object occlusion",
      "manual 3D calibration",
      "multi-zone",
      "split-zone",
      "AI debug overlay",
      "debug metrics overlay",
      "experimental URL flags"
    ],
    assetHardening:[
      "local-first static shapes candidates",
      "legacy GitHub shapes fallback disabled",
      "gateway palette fallback disabled in public release",
      "strict CORS-only texture loading",
      "allowlisted remote ML/runtime origins only"
    ],
    capabilityHardening:[
      "runtime capability matrix (safe / reduced / full)",
      "automatic Ultra downgrade on weak devices or huge photos",
      "depth stage disabled in safe mode",
      "balanced Ultra profile for medium devices"
    ],
    simpleModeShell:[
      "guided 4-step public shell (photo → zone → tile → result)",
      "secondary tools hidden by default",
      "contextual primary action button for the current simple step"
    ]
  };

  function _feature(name){
    return (features && Object.prototype.hasOwnProperty.call(features, name)) ? features[name] : null;
  }
  function isEnabled(name, fallback){
    const f = _feature(name);
    return f ? (f.enabled !== false) : !!fallback;
  }
  function isVisible(name, fallback){
    const f = _feature(name);
    return f ? (f.visible !== false) : !!fallback;
  }
  function describe(name){
    return _feature(name);
  }

  return {
    preset,
    patch,
    features,
    inventory,
    assetDelivery,
    capabilityMatrix,
    analytics,
    simpleMode,
    resolveCapabilityProfile,
    getAllowedOrigins,
    isAssetAllowed,
    isEnabled,
    isVisible,
    describe
  };
})();
