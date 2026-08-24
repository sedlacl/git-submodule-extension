import type { AdoptedTreeNode } from "../src/views/adoptedViewModel.js";
import { BUILTIN_GROUP_LABELS } from "../src/views/builtinGitParity.js";
import { CONTEXT } from "../src/views/constants.js";

/** Neutral demo names for README / marketplace screenshots — never use real repo names here. */
export const README_SCREENSHOT_DEMO = {
  roots: {
    webApp: "web-app",
    platformInfra: "platform-infra",
    docsSite: "docs-site",
  },
  submodules: {
    uiKit: "libs/ui-kit",
    apiClient: "libs/api-client",
    auth: "services/auth",
    gateway: "services/gateway",
  },
  branches: {
    main: "main",
    featureCheckout: "feature/checkout",
    release: "release/1.2",
  },
  pointers: {
    staged: "abc1234 → def5678",
    unstaged: "fedcba9 → main",
  },
  files: {
    readme: "README.md",
    index: "src/index.ts",
    loginRoute: "src/routes/login.ts",
    notes: "notes.txt",
    gitmodules: ".gitmodules",
  },
  commitDraft: "feat(web-app): bump api-client submodule",
  commitPlaceholder: 'Message (commit on "main")',
} as const;

const DEMO_ROOT = "/demo";

function demoRootPath(name: string): string {
  return `${DEMO_ROOT}/${name}`;
}

function demoSubmodulePath(rootName: string, submodulePath: string): string {
  return `${demoRootPath(rootName)}/${submodulePath}`;
}

function changeFile(
  id: string,
  label: string,
  badge: string,
  color: string,
  group: "index" | "workingTree",
): AdoptedTreeNode {
  const ctx = group === "index" ? CONTEXT.changeIndex : CONTEXT.changeWorkingTree;
  return {
    id,
    kind: "change",
    label,
    tooltip: label,
    collapsible: false,
    expandByDefault: false,
    contextValue: ctx,
    iconId: "file",
    decoration: { badge, tooltip: badge, themeColorId: color },
    children: [],
  };
}

function adoptedFile(id: string, label: string, badge: string): AdoptedTreeNode {
  return {
    id,
    kind: "file",
    label,
    tooltip: label,
    collapsible: false,
    expandByDefault: false,
    contextValue: CONTEXT.file,
    iconId: "file",
    decoration: { badge, tooltip: badge, themeColorId: "gitDecoration.modifiedResourceForeground" },
    children: [],
  };
}

/** Demo tree rendered by `npm run capture-readme-screenshot` (default dataset). */
export function buildReadmeScreenshotDemoTree(): AdoptedTreeNode[] {
  const { roots, submodules, branches, pointers, files } = README_SCREENSHOT_DEMO;
  const webApp = demoRootPath(roots.webApp);
  const apiClientSub = demoSubmodulePath(roots.webApp, submodules.apiClient);
  const authSub = demoSubmodulePath(roots.webApp, submodules.auth);

  return [
    {
      id: `root:${webApp}`,
      kind: "workspace-root",
      label: roots.webApp,
      description: `${branches.main}*+`,
      tooltip: roots.webApp,
      repositoryRoot: webApp,
      collapsible: true,
      expandByDefault: true,
      contextValue: CONTEXT.workspaceRoot,
      iconId: "repo",
      children: [
        {
          id: `group:${webApp}:index`,
          kind: "change-group",
          changeGroup: "index",
          label: BUILTIN_GROUP_LABELS.index,
          description: "1",
          tooltip: BUILTIN_GROUP_LABELS.index,
          collapsible: true,
          expandByDefault: true,
          contextValue: CONTEXT.changeGroupIndex,
          iconId: "",
          children: [
            {
              id: `gitlink:${apiClientSub}:staged`,
              kind: "change",
              label: submodules.apiClient,
              description: pointers.staged,
              tooltip: "gitlink",
              collapsible: true,
              expandByDefault: true,
              contextValue: CONTEXT.gitlink,
              iconId: "file-submodule",
              decoration: {
                badge: "S",
                tooltip: "Submodule",
                themeColorId: "gitDecoration.submoduleResourceForeground",
              },
              children: [
                {
                  id: `adopted:${apiClientSub}:staged`,
                  kind: "adopted-group",
                  label: "Adopted Changes",
                  description: "3",
                  tooltip: "Adopted Changes",
                  collapsible: true,
                  expandByDefault: true,
                  contextValue: CONTEXT.adoptedGroup,
                  iconId: "",
                  children: [
                    adoptedFile(`file:${apiClientSub}:1`, files.readme, "M"),
                    adoptedFile(`file:${apiClientSub}:2`, files.index, "M"),
                    adoptedFile(`file:${apiClientSub}:3`, files.loginRoute, "A"),
                  ],
                },
              ],
            },
          ],
        },
        {
          id: `group:${webApp}:workingTree`,
          kind: "change-group",
          changeGroup: "workingTree",
          label: BUILTIN_GROUP_LABELS.workingTree,
          description: "2",
          tooltip: BUILTIN_GROUP_LABELS.workingTree,
          collapsible: true,
          expandByDefault: true,
          contextValue: CONTEXT.changeGroupWorkingTree,
          iconId: "",
          children: [
            {
              id: `gitlink:${authSub}:unstaged`,
              kind: "change",
              label: submodules.auth,
              description: pointers.unstaged,
              tooltip: "gitlink",
              collapsible: true,
              expandByDefault: true,
              contextValue: CONTEXT.gitlink,
              iconId: "file-submodule",
              decoration: {
                badge: "S",
                tooltip: "Submodule",
                themeColorId: "gitDecoration.submoduleResourceForeground",
              },
              children: [
                {
                  id: `sub:${authSub}`,
                  kind: "submodule",
                  label: "services/auth",
                  description: `${branches.main}*`,
                  repositoryRoot: authSub,
                  tooltip: submodules.auth,
                  collapsible: true,
                  expandByDefault: true,
                  contextValue: CONTEXT.submodule,
                  iconId: "repo",
                  decoration: {
                    themeColorId: "gitDecoration.submoduleResourceForeground",
                    tooltip: "Submodule",
                  },
                  children: [
                    {
                      id: `group:${authSub}:workingTree`,
                      kind: "change-group",
                      changeGroup: "workingTree",
                      label: BUILTIN_GROUP_LABELS.workingTree,
                      description: "1",
                      tooltip: BUILTIN_GROUP_LABELS.workingTree,
                      collapsible: true,
                      expandByDefault: true,
                      contextValue: CONTEXT.changeGroupWorkingTree,
                      iconId: "",
                      children: [
                        changeFile(
                          `file:${authSub}:1`,
                          files.notes,
                          "M",
                          "gitDecoration.modifiedResourceForeground",
                          "workingTree",
                        ),
                      ],
                    },
                  ],
                },
              ],
            },
            changeFile(
              `file:${webApp}:1`,
              files.gitmodules,
              "M",
              "gitDecoration.modifiedResourceForeground",
              "workingTree",
            ),
          ],
        },
      ],
    },
    {
      id: `root:${demoRootPath(roots.platformInfra)}`,
      kind: "workspace-root",
      label: roots.platformInfra,
      description: branches.release,
      tooltip: roots.platformInfra,
      repositoryRoot: demoRootPath(roots.platformInfra),
      collapsible: true,
      expandByDefault: false,
      contextValue: CONTEXT.workspaceRoot,
      iconId: "repo",
      decoration: { themeColorId: "gitDecoration.submoduleResourceForeground", tooltip: "Descendant changes" },
      children: [],
    },
    {
      id: `root:${demoRootPath(roots.docsSite)}`,
      kind: "workspace-root",
      label: roots.docsSite,
      description: branches.featureCheckout,
      tooltip: roots.docsSite,
      repositoryRoot: demoRootPath(roots.docsSite),
      collapsible: true,
      expandByDefault: false,
      contextValue: CONTEXT.workspaceRoot,
      iconId: "repo",
      children: [],
    },
  ];
}

export function readmeScreenshotDemoWebviewOptions(): {
  drafts: Map<string, string>;
  placeholders: Map<string, string>;
  generateCommitMessageSupportedRoots: Set<string>;
} {
  const webApp = demoRootPath(README_SCREENSHOT_DEMO.roots.webApp);
  return {
    drafts: new Map([[webApp, README_SCREENSHOT_DEMO.commitDraft]]),
    placeholders: new Map([[webApp, README_SCREENSHOT_DEMO.commitPlaceholder]]),
    generateCommitMessageSupportedRoots: new Set([webApp]),
  };
}

/** Substrings that must not appear in packaged screenshot HTML / PNG source. */
export const README_SCREENSHOT_FORBIDDEN_NAMES = [
  "usy_idsmari_commong01",
  "uu_energygateway_httpendpointg01",
  "usy_aflex_initdatag01",
  "usy_iedc_initdatag01",
  "infra-deploy",
  "httpendpoint",
] as const;
