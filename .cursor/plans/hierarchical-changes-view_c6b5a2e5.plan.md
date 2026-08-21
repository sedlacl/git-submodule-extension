---
name: hierarchical-changes-view
overview: Přestavět současný Submodules TreeView na hlavní hierarchický „Changes“ panel, který používá stav a operace veřejného `vscode.git` API a kopíruje každodenní semantiku i slovník built-in SCM. Zachová repository → submodule hierarchii a přidá parent-level Adopted Changes; built-in Changes si uživatel skryje ručně, protože stabilní API jej neumí nahradit ani skrýt.
todos:
  - id: repository-state-model
    content: Rozšířit vscode.git adaptér a view model o merge/index/working-tree/untracked změny všech hierarchických repozitářů.
    status: completed
  - id: builtin-like-tree
    content: Přestavět pane na built-in-like Changes/Staged/Adopted strom s přesným slovníkem, vizuálem a parent-level pointery.
    status: completed
  - id: daily-git-actions
    content: Implementovat diff, stage/unstage/discard, commit Quick Input, refresh a sync/publish se správným cílovým repozitářem.
    status: completed
  - id: submodule-chore
    content: Přidat message-only mechanické chore summary podle update-submodules.js.
    status: completed
  - id: verify-hierarchical-scm
    content: Doplnit unit/integration/Extension Host testy a ověřit živé Cursor UI i VSIX.
    status: completed
isProject: false
---

# Hierarchický Changes panel

## Architektura a model stavu

- Ponechat nativní `TreeView` jako jedinou stabilní cestu k hierarchii repository → submodule → nested submodule; nevytvářet duplicitní vlastní `SourceControl` providery. V README jasně uvést ruční skrytí built-in `Changes` panelu.
- Rozšířit veřejné deklarace a adaptér [`src/git/git.d.ts`](R:/External/git-submodule-extension/src/git/git.d.ts) a [`src/git/vscodeGitApi.ts`](R:/External/git-submodule-extension/src/git/vscodeGitApi.ts), aby z `vscode.git` přebíraly repository state, change resources a mutační operace. Git CLI ponechat pro submodule/gitlink dotazy a mechanický commit summary, ne jako primární frontu stage/commit/sync operací.
- Zavést jednotný repository view model pro merge/index/working-tree/untracked stav a zachovat stávající rekurzivní parenthood model. Sledovat změny všech repo stavů a atomicky obnovovat příslušnou větev stromu.

## Built-in Git jako referenční implementace

- Pro každou funkci, která má být stejná, nejprve dohledat odpovídající implementaci v MIT zdrojích `microsoft/vscode/extensions/git` ve verzi blízké cílovému Cursor/VSCodium buildu: repository/resource model, command handlers, confirmations, decorations, nastavení a menu manifest.
- Převzít veřejné API signatury a behaviorální rozhodnutí, ne celý extension fork. Kód závislý na privilegovaných proposed API (`scmActionButton`, `scmMultiDiffEditor`, `scmValidation`, interní provider hierarchy) nahradit stabilním ekvivalentem nebo explicitně označeným fallbackem.
- U adaptovaných větších úseků zachovat MIT hlavičky/atribuci a evidovat upstream soubor a revizi. Built-in command IDs ani interní resource objekty nepoužívat jako neveřejný kontrakt; mutace volat přes exportované `vscode.git` API.

## Vizuál a hierarchie

- Přejmenovat pane na `Changes` a v [`src/views/adoptedViewModel.ts`](R:/External/git-submodule-extension/src/views/adoptedViewModel.ts) skládat každý repository uzel v pořadí `Merge Changes` (jen při konfliktech), `Staged Changes`, `Changes`, `Adopted Changes`, potom přímé child repositories.
- Mimo `Adopted Changes` používat built-in slovník, pořadí, badge počty, ThemeIcon/file icons, dekorace M/A/D/R/U, branch/upstream popis a inline/context akce. Respektovat relevantní SCM nastavení pro tree/list zobrazení, compact folders a sort key, pokud je stabilní API zpřístupňuje.
- Dokončit a ověřit již rozpracovanou parent-level strukturu: root `httpendpoint` vlastní adopted pointery přímých dětí; `usy_idsmari_commong01` vlastní pointer `uu_energygateway_datagatewayg01`. Prázdné `Adopted Changes` se nezobrazují. Běžný gitlink resource zůstává zároveň ve standardní `Changes`/`Staged Changes`, protože je to skutečně stageovatelná změna parent repa.

## Daily-core Git operace

- Přidat přesné příkazy a context menus v [`package.json`](R:/External/git-submodule-extension/package.json) a obsluhu v nové vrstvě [`src/scm/`](R:/External/git-submodule-extension/src/scm/):
  - soubor/složka/multiselect/group: Open Changes, Stage Changes, Unstage Changes, Discard Changes, Stage All, Unstage All a Discard All;
  - repository: Commit, Refresh, Sync Changes nebo Publish Branch;
  - destruktivní discard vždy s potvrzením a správným zacházením s untracked, rename, delete a konflikty.
- Diff semantika musí odpovídat Gitu: staged `HEAD → index`, unstaged `index → working tree`; preferovat URI/operace veřejného `vscode.git` API a zachovat stávající content provider jen tam, kde built-in API nestačí.
- Commit na repository řádku otevře nativní Quick Input pro správné repo. Pokud není nic staged, napodobí smart-commit rozhodnutí bezpečným promptem; žádné automatické stage bez potvrzení.

## Mechanický submodule chore

- Přidat repository inline akci ve stylu built-in „Generate Commit Message“. Je pouze read-only/message-only: nic nestageuje, necommitne, nepullne ani nepushne.
- Generovat formát podle [`R:/Mddp/usy_ids_httpendpointg01/update-submodules.js`](R:/Mddp/usy_ids_httpendpointg01/update-submodules.js): `chore: update submodules`, pro každý přímý změněný gitlink path, krátké before/after SHA, aktuální branch a nejvýše 30 commit subjectů plus `... N more commits`.
- Pro staged pointer použít `HEAD → index`; pro dosud unstaged pointer připravovaný k budoucímu commitu použít `HEAD → checkout HEAD` a v preview označit, že změna ještě není staged. Quick Input upravuje subject; mechanické body zůstanou součástí následně potvrzené commit zprávy.

## Ověření

- TDD testy pro repository/group/file hierarchii, přesné názvy a pořadí, status/dekorace, parent-level Adopted Changes a absenci prázdných groups.
- Unit testy command routeru nad fake `vscode.git` repository: item/group/multiselect stage, unstage, discard confirmations, commit/smart commit, refresh, sync/publish a chybové stavy.
- Přidat parity testy odvozené z built-in Git manifestu a chování: stejné labels, group ordering, status mapování, relevantní `git.*` settings a potvrzovací větve; odchylky musí být úmyslně zdokumentované.
- Integrační testy na fixture `httpendpoint`, `infra-deploy` a multi-root workspace ověří běžné změny i gitlinky na každé úrovni, včetně rename/delete/untracked/conflict a správného cílového repo.
- Extension Host a živý Cursor na izolovaném profilu ověří DOM slovník, pořadí, counts a inline akce proti built-in SCM; restore zůstane ve fixture vypnutý. Nakonec spustit lint, typecheck, všechny testy, build a validaci VSIX.

## Mimo tuto iteraci

- AI generování commit summary, plný commit cascade, pull/push cascade, stash, checkout/branch management, merge/rebase UI a proposed SCM API.
