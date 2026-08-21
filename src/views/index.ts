export { COMMANDS, CONTEXT, GIT_SHOW_SCHEME, VIEW_ID } from "./constants.js";
export { AdoptedTreeController } from "./adoptedTreeController.js";
export {
  applyRestoreOverlay,
  buildAdoptedTree,
  collectDiffSpecs,
  fileDecoration,
  fileNodesFromNameStatus,
  submoduleIcon,
  submoduleStatusSummary,
  treeCollapsibleMode,
  treeItemCommand,
  usesThemeFileIcon,
} from "./adoptedViewModel.js";
export type { AdoptedFileDiff, AdoptedTreeNode } from "./adoptedViewModel.js";
export { openPreparedChanges, prepareFileDiff, prepareOpenAll } from "./adoptedDiffPrep.js";
export { registerAdoptedView } from "./registerAdoptedView.js";
export { SubmoduleTreeProvider } from "./submoduleTree.js";
