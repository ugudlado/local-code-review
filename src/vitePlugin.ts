import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { SessionStore } from "./sessionStore";
import { SkillGenerator } from "./skillGenerator";
import { createCaptureHandler } from "./captureServer";
import {
  currentBranchSync,
  detectTargetBranch,
  repoRootSync,
  toSessionId,
} from "./repoContext";

// ---------------------------------------------------------------------------
// Vite plugin: the complete browser-feedback surface for Vite projects.
//
//   // vite.config.ts
//   import { resolvrAnnotations } from "resolvr/vite";
//   export default { plugins: [resolvrAnnotations()] };
//
// Because the plugin runs inside the dev server, in the project directory, it
// carries the session context itself ("the checkout you launched from") and
// mounts the capture endpoints on the dev server's own origin under
// /__resolvr/ — no CORS, no separate port, works with VS Code closed. The
// injected script tag points at /__resolvr/annotate.js (relative, same
// origin) and the capture script derives all endpoint URLs from its own src.
//
// Dev-server only (`apply: "serve"`) — production builds are untouched.
// Typed structurally instead of importing vite so this adds no dependency;
// the shapes below are the stable subset of vite's Plugin API.
// ---------------------------------------------------------------------------

interface HtmlTagDescriptor {
  tag: string;
  attrs?: Record<string, string | boolean>;
  injectTo?: "head" | "body" | "head-prepend" | "body-prepend";
}

interface ConnectLike {
  use(
    route: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): void;
}

interface ViteDevServerLike {
  middlewares: ConnectLike;
  config: {
    root: string;
    logger: { info(msg: string): void; warn(msg: string): void };
  };
}

interface ResolvrVitePlugin {
  name: string;
  apply: "serve";
  configureServer: (server: ViteDevServerLike) => void;
  transformIndexHtml: () => HtmlTagDescriptor[];
}

export interface ResolvrAnnotationsOptions {
  /** Override the review target branch (else auto-detected main/master). */
  targetBranch?: string;
}

const MOUNT = "/__resolvr";

export function resolvrAnnotations(
  options: ResolvrAnnotationsOptions = {},
): ResolvrVitePlugin {
  return {
    name: "resolvr-annotations",
    apply: "serve",

    configureServer(server) {
      const log = (msg: string) =>
        server.config.logger.info(`[resolvr] ${msg}`);
      const workspaceRoot = repoRootSync(server.config.root);
      if (!workspaceRoot) {
        server.config.logger.warn(
          "[resolvr] not a git repository — annotations disabled",
        );
        return;
      }
      const launchBranch = currentBranchSync(workspaceRoot);
      const sessionStore = new SessionStore({ workspaceRoot });
      const targetBranch = () =>
        detectTargetBranch(workspaceRoot, options.targetBranch);

      // Session + agent context files exist before the first annotation, so
      // an agent can pick up feedback through .review/ from the start. Never
      // let this break the dev server.
      if (launchBranch) {
        const sessionId = toSessionId(launchBranch);
        void (async () => {
          try {
            const { session } = await sessionStore.ensureSession(sessionId, {
              worktreePath: workspaceRoot,
              sourceBranch: launchBranch,
              targetBranch: targetBranch(),
            });
            const skillGenerator = new SkillGenerator(
              workspaceRoot,
              targetBranch,
            );
            const skillContext = await skillGenerator.buildContext(
              sessionId,
              sessionStore.getSessionFilePath(sessionId),
              session,
            );
            await skillGenerator.generate(skillContext, session);
            log(`session "${launchBranch}" ready — annotate at ${MOUNT}/`);
          } catch (err) {
            server.config.logger.warn(
              `[resolvr] session setup failed: ${String(err)}`,
            );
          }
        })();
      } else {
        server.config.logger.warn(
          "[resolvr] detached HEAD — annotations disabled until a branch is checked out",
        );
      }

      server.middlewares.use(
        MOUNT,
        createCaptureHandler({
          getSessionId: () => {
            const branch = currentBranchSync(workspaceRoot);
            return branch ? toSessionId(branch) : null;
          },
          ensureSessionDefaults: () => ({
            worktreePath: workspaceRoot,
            sourceBranch:
              currentBranchSync(workspaceRoot) ?? launchBranch ?? "unknown",
            targetBranch: targetBranch(),
          }),
          sessionStore,
          getContext: () => {
            const branch = currentBranchSync(workspaceRoot);
            return {
              workspaceName: path.basename(workspaceRoot),
              workspaceRoot,
              branch,
              sessionId: branch ? toSessionId(branch) : null,
              launchBranch: launchBranch ?? undefined,
            };
          },
          annotateScriptPath: path.join(
            __dirname,
            "..",
            "assets",
            "annotate.js",
          ),
          log,
        }),
      );
    },

    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { src: `${MOUNT}/annotate.js` },
          injectTo: "body",
        },
      ];
    },
  };
}
