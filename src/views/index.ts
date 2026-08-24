export { COMMANDS, CONTEXT, GIT_SHOW_SCHEME, VIEW_ID } from "./constants.js";
export { AdoptedTreeController } from "./adoptedTreeController.js";
export { gitModelNeedsRediscovery } from "./gitModelRefresh.js";
export {
  applyRestoreOverlay,
  buildAdoptedTree,
  buildChangesTree,
  collectChangeRefs,
  collectDiffSpecs,
  fileDecoration,
  fileNodesFromNameStatus,
  submoduleIcon,
  submoduleStatusSummary,
  treeCollapsibleMode,
  treeItemCodicon,
  treeItemCommand,
  treeItemFileKindIcon,
  usesThemeFileIcon,
} from "./adoptedViewModel.js";
export type { AdoptedFileDiff, AdoptedTreeNode, ChangeFileRef } from "./adoptedViewModel.js";
export { openPreparedChanges, prepareFileDiff, prepareOpenAll } from "./adoptedDiffPrep.js";
export { registerAdoptedView } from "./registerAdoptedView.js";
export { SubmoduleTreeProvider } from "./submoduleTree.js";
export { DEFAULT_CHANGES_TREE_SETTINGS, readChangesTreeSettings } from "./changesTreeSettings.js";
export { BUILTIN_COMMAND_TITLES, BUILTIN_GIT_DEVIATIONS, BUILTIN_GROUP_LABELS } from "./builtinGitParity.js";
