---
name: git-submodule-extension
overview: Inicializovat lokální TypeScript VS Code extension, která v Source Control panelu zobrazí rekurzivní hierarchii submodulů a „Adopted Changes“ a bezpečně obnoví větve submodulů po Git operacích. Projekt bude připravený pro GitHub `sedlacl/git-submodule-extension` a Open VSX publisher `qjohn`, ale bez externí publikace.
todos:
  - id: scaffold
    content: Inicializovat extension, metadata, MIT licenci, build/test/package konfiguraci a release workflow.
    status: completed
  - id: isolated-ui-harness
    content: Přidat rychlý izolovaný Extension Development Host s prázdným profilem a generovanou Git fixture.
    status: completed
  - id: git-model
    content: Implementovat Git API/CLI vrstvu a rekurzivní model parentů a submodulů.
    status: completed
  - id: adopted-view
    content: Implementovat SCM TreeView, Adopted Changes a single/multi-file diff.
    status: completed
  - id: branch-restore
    content: Implementovat rekurzivní auto-safe obnovu větví s fail-closed kontrolami.
    status: completed
  - id: verify
    content: Doplnit unit/integration testy a ověřit build, VSIX i reálný vnořený repozitář.
    status: completed
isProject: false
---

# Git Submodule extension MVP

## Základ projektu

- Inicializovat Git a TypeScript extension v [`R:/External/git-submodule-extension/package.json`](R:/External/git-submodule-extension/package.json) s identifikátorem `git-submodule-extension`, publisherem `qjohn`, MIT licencí, závislostí na `vscode.git`, konzervativním `engines.vscode` a aktivací jen pro Git workspace/SCM view.
- Přidat esbuild, lint, unit/integration testy, VSIX packaging, README a release workflow v [`.github/workflows/release.yml`](R:/External/git-submodule-extension/.github/workflows/release.yml). Workflow připraví GitHub Release a Open VSX publish přes `OVSX_PAT`; nyní nic nepublikuje.

## Izolovaný UI vývoj

- Přidat `npm run dev:ui`, který spustí cachovaný Extension Development Host přes `@vscode/test-electron` s odděleným `--user-data-dir`, prázdným `--extensions-dir` a pouze touto extension přes `--extensionDevelopmentPath`; žádné uživatelské extension ani nastavení, z built-in služeb extension využije jen potřebný Git provider.
- V [`scripts/create-ui-fixture.ts`](R:/External/git-submodule-extension/scripts/create-ui-fixture.ts) deterministicky vytvořit lokální Git repozitáře bez síťových remote. Fixture bude mít dvě reprezentativní topologie: `httpendpoint` podle `R:/Mddp/usy_ids_httpendpointg01` (dva přímé submoduly, jeden z nich s vnořeným submodulem) a `infra-deploy` podle `R:/uuCloudg02/usy_ids_infra_deployg01` (více checkoutů stejných zdrojových repozitářů pod cestami s `#t1/#t2/#prod` a různými větvemi). Připravené scénáře pokryjí clean, staged/unstaged pointer, dirty, detached a diverged stav.
- Generovat také izolovaný multi-root `.code-workspace` podle `R:/Mddp/usy_aflex_initdatag01-dev.code-workspace`: několik nezávislých top-level repozitářů, z nichž jen některé obsahují submoduly. `dev:ui` otevře tento workspace, aby extension ověřovala workspace-level discovery a zanořila pouze skutečné gitlink potomky.
- Výchozí start použije esbuild watch a znovupoužije stažený VS Code runtime i izolovaný profil pro rychlé iterace; samostatný reset fixture bude explicitní příkaz. Finální kompatibilitu jednorázově ověřit také v Cursoru se stejně prázdným profilem.

## Git model a hierarchie

- V [`src/git/`](R:/External/git-submodule-extension/src/git/) vytvořit adaptér nad veřejným `vscode.git` API a bezpečný Git CLI runner používající Git binary z API, bez shell interpolace.
- Rekurzivně číst `.gitmodules` a gitlinky `160000` pro každý parent repository, sestavit strom workspace repo → přímý submodul → vnořený submodul a odlišit pin, index SHA, checkout HEAD, branch, detached/dirty/diverged a neinicializovaný stav.
- Více-rootové workspace mapovat podle skutečných gitlinků, ne podle plochého seznamu repozitářů. Top-level workspace folders zůstanou sourozenci; submoduly se zanoří pod bezprostřední parent bez ohledu na to, zda je VS Code Git API současně hlásí jako samostatný repository. Ověřit na `R:/Mddp/usy_aflex_initdatag01-dev.code-workspace` a na vnoření `uu_energygateway_datagatewayg01` pod `usy_idsmari_commong01`.

## Source Control UX a Adopted Changes

- Přidat vlastní hierarchický TreeView do standardního SCM panelu v [`src/views/submoduleTree.ts`](R:/External/git-submodule-extension/src/views/submoduleTree.ts); built-in Git provider zůstane beze změny, protože stabilní VS Code API jej neumí rozšířit.
- U každého repository uzlu zobrazit skupinu `Adopted Changes`. Unstaged posun porovná `index gitlink → checkout HEAD`, staged posun `HEAD gitlink → index gitlink`; vnořené posuny se počítají vůči jejich bezprostřednímu parentu.
- Přes `git diff --name-status -z --find-renames A B` zobrazit změněné soubory a po kliknutí otevřít nativní `vscode.diff`; příkaz „Open All“ použije `vscode.changes` s fallbackem na jednotlivé diffy. Přidat refresh a stavové/dekorační ikony, ale žádné automatické otevírání editorů.

## Bezpečné zachování větve

- V [`src/restore/branchReconciler.ts`](R:/External/git-submodule-extension/src/restore/branchReconciler.ts) implementovat rekurzivní `auto-safe` reconcile po checkout/commit/state-change událostech parent repozitářů, s debounce, per-path mutexem, generation guardem a deduplikací chyb.
- Převzít fail-closed pravidla z `R:/uuCloudg02/usy_ids_infra_deployg01/scripts/attach-submodules.js`: cílová větev z committed `.gitmodules`, cílové SHA z aktuálního parent gitlinku, čistý child, žádná probíhající Git operace, existující pin/remote branch, pin na správné remote větvi a žádné lokální unikátní commity.
- Bezpečný případ obnoví `git switch -C <branch> <pin>` a upstream, poté ověří branch/HEAD/upstream. Extension nikdy automaticky nedělá pull, push, commit, force, discard ani síťový fetch; blokované případy ukáže v tree/output a nabídne ruční retry/fetch příkaz.

## Ověření

- Unit testy pokryjí parser `.gitmodules`, rekurzivní strom, staged/unstaged A→B, rename/add/delete, safety matici a event-loop ochrany.
- Integrační testy použijí obě fixture topologie i multi-root workspace a ověří discovery, adopted diff na přímé i vnořené úrovni, opakované checkouty stejného source repo na různých větvích, bezpečné znovupřipojení větve, no-op opakování, dirty/diverged blokaci a chybějící ref.
- Spustit lint, typecheck, unit/integration testy, build a vytvoření/validaci lokálního VSIX; ručně ověřit SCM strom proti `R:/Mddp/usy_ids_httpendpointg01`, `R:/uuCloudg02/usy_ids_infra_deployg01` a `R:/Mddp/usy_aflex_initdatag01-dev.code-workspace`.
