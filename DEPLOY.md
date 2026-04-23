P11 texture 2k-first with safe fallback to 1k + map-set diagnostics

Что изменено:
- фронт теперь резолвит карты материала по политике 2k-first → safe fallback 1k;
- политика применяется к albedo, normal, roughness, ao, height;
- при фактической загрузке фронт фиксирует, какая версия карты реально загрузилась;
- diagnostics snapshot теперь показывает map-set summary и resolution hints для активных материалов.

Что проверить после деплоя:
1. выбрать форму и текстуру;
2. убедиться, что материал применяется как раньше;
3. при наличии 2k-карт они должны грузиться первыми;
4. при отсутствии 2k должен сработать безопасный fallback на 1k;
5. в diagnostics snapshot должны быть textureLoadInfo / lastTextureLoad и mapsSummary.
