# Синхронизация с апстримом (pmxt)

Этот репозиторий — **приватный форк** `pmxt-dev/pmxt` с интеграцией Outlayer.
Вся наша работа живёт прямо на `main` приватного репо. Документ описывает, как
безопасно подтягивать обновления из публичного апстрима, не утекая туда своим кодом.

## Раскладка remote'ов

| remote     | URL                                          | назначение                                  |
|------------|----------------------------------------------|---------------------------------------------|
| `private`  | `git@github.com:zavodil/outlayer-predictions-backend.git` | **наш приватный репо**, сюда пушим          |
| `upstream` | `git@github.com:pmxt-dev/pmxt.git`           | оригинал, **только fetch** (push отключён)  |
| `origin`   | `git@github.com:zavodil/pmxt.git`            | старый публичный форк, не используем         |

Проверить: `git remote -v`

Локальный `main` трекает `private/main`, поэтому обычный `git push` уходит в приватный репо.

## Золотое правило

> Наш код пушим **только в `private`**. В `origin` (публичный) и `upstream` — никогда.

Защиты, которые уже стоят:
- push в `upstream` отключён (`upstream ... DISABLE`);
- `main` трекает `private/main`, `remote.pushDefault = private`;
- никогда не делай `git push origin ...` руками.

## Как синкать обновления апстрима

```bash
# 1. Забрать свежие изменения апстрима (только скачивание, ничего не меняет локально)
git fetch upstream

# 2. Посмотреть, что нового прилетело
git log --oneline main..upstream/main

# 3. Влить их в наш main
git checkout main
git merge upstream/main        # или: git rebase upstream/main

# 4. Запушить результат в приватный репо
git push                       # уйдёт в private/main
```

### Если хочется rebase вместо merge
`merge` проще и сохраняет историю слияний — рекомендуется по умолчанию.
`rebase` даёт линейную историю, но переписывает наши коммиты поверх апстрима:

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git push --force-with-lease    # после rebase нужен force (только в private!)
```

## Конфликты

Конфликты возникают там, где наши правки пересекаются с правками апстрима
(`core/src/server/app.ts`, `exchange-factory.ts`, `package.json`, `package-lock.json` —
наиболее вероятные места).

```bash
# во время merge с конфликтами:
git status                     # покажет конфликтные файлы
# ... вручную правим файлы, убираем маркеры <<<<<<< ======= >>>>>>> ...
git add <файл>
git commit                     # завершить merge

# если решили прервать слияние и вернуться как было:
git merge --abort
```

После разрешения конфликтов проверь сборку (`npm run build` в `core/`) перед push.

## Шпаргалка

```bash
git fetch upstream                       # скачать апстрим
git log --oneline main..upstream/main    # что нового
git merge upstream/main                  # влить в наш main
git push                                 # → private/main
```

## Чего НЕ делать

- ❌ `git push origin ...` — это публичный форк.
- ❌ `git push upstream ...` — отключено намеренно, не включай обратно.
- ❌ форсить push в публичные репозитории.
