import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { maybeMigrateModelCatalogCredentials } from "../commands/doctor-model-catalog-credentials.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { repairCanonicalSessionKeys } from "../commands/doctor-session-canonical-keys.js";
import { noteSessionTranscriptHeaderHealth } from "../commands/doctor-session-transcript-headers.js";
import { noteSessionTranscriptLabelHealth } from "../commands/doctor-session-transcript-labels.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { detectTelegramGeneralTopicConversationRepairs } from "../commands/doctor-telegram-general-topic-conversations.js";
import { maybeRepairCodexSessionRoutes } from "../commands/doctor/shared/codex-route-session-repair.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawDatabaseSchemas,
} from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "./state-migrations.media-persistence-targets.js";
import {
  createLegacyDatabaseFixture,
  readDatabaseSnapshot,
} from "./state-migrations.media-persistence.test-support.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  note.mockClear();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Doctor with a deleted agent database", () => {
  it("repairs a configured survivor when only the deleted owner's registration remains", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("doctor-configured-survivor-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      plugins: { enabled: false },
    };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {},
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    registerOpenClawAgentDatabase({ agentId: "retired", path: databasePath, env });
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: "delete-retired",
        agentDir: path.dirname(databasePath),
        workspaceDir: path.join(stateDir, "workspace-retired"),
        sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
        deleteFiles: false,
      },
      { env },
    );
    runOpenClawStateWriteTransaction(
      (database) => {
        completeAgentDeletionJournalInDatabase(database, "retired", "delete-retired");
      },
      { env },
    );
    unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath, env });
    expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
      scannedStores: 1,
    });
    unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath, env });
    fs.writeFileSync(
      path.join(path.dirname(databasePath), "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            apiKey: "synthetic-catalog-key",
            models: [],
          },
        },
      }),
    );
    const runtime = {
      log() {},
      error() {},
      exit(code: number): never {
        throw new Error(`unexpected exit ${code}`);
      },
    };
    const catalogs = await maybeMigrateModelCatalogCredentials({
      cfg,
      env,
      runtime,
      prompter: createDoctorPrompter({ runtime, options: { repair: true, nonInteractive: true } }),
    });
    expect(catalogs).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
  });

  it.each([
    { deleteFiles: false, registered: true, location: "default" },
    { deleteFiles: false, registered: false, location: "default" },
    { deleteFiles: false, registered: false, location: "custom" },
    { deleteFiles: false, registered: false, location: "old-name" },
    { deleteFiles: true, registered: true, location: "default" },
  ])(
    "preserves deleted state (deleteFiles=$deleteFiles, registered=$registered, location=$location)",
    async ({ deleteFiles, registered, location }) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("doctor-retained-deletion-"));
      const env = { OPENCLAW_STATE_DIR: stateDir };
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
        plugins: { enabled: false },
      };
      const activePath = createLegacyDatabaseFixture({
        env,
        eventsBySession: {},
        schemaVersion: 19,
      });
      const retainedPath = createLegacyDatabaseFixture({
        agentId: "retired",
        env,
        eventsBySession: {},
        schemaVersion: 19,
        ...(location !== "default"
          ? {
              path: path.join(
                location === "custom"
                  ? tempDirs.make("doctor-retained-custom-")
                  : path.join(stateDir, "agents", "old-name"),
                "agent",
                "openclaw-agent.sqlite",
              ),
            }
          : {}),
      });
      const agentDir = path.dirname(retainedPath);
      const workspaceDir = path.join(stateDir, "workspace-retired");
      beginAgentDeletionJournal(
        {
          agentId: "retired",
          operationId: "delete-retired",
          agentDir,
          workspaceDir,
          sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
          deleteFiles,
        },
        { env },
      );
      if (!deleteFiles) {
        runOpenClawStateWriteTransaction(
          (database) => {
            completeAgentDeletionJournalInDatabase(database, "retired", "delete-retired");
          },
          { env },
        );
      }
      if (!registered) {
        unregisterOpenClawAgentDatabase({ agentId: "retired", path: retainedPath, env });
      }
      const before = fs.readFileSync(retainedPath);
      const candidatePath =
        !deleteFiles && registered && location === "default"
          ? path.join(stateDir, "retained-candidate.sqlite")
          : retainedPath;
      if (candidatePath !== retainedPath) {
        fs.linkSync(retainedPath, candidatePath);
      }
      let prepared: PreparedAgentDatabaseMigrationDiscovery | undefined;
      const preflight = await preflightOpenClawDatabaseSchemas({
        env,
        configuredAgentDatabaseTargets: [],
        configuredAgentDatabaseCandidatePaths: [candidatePath],
        onAgentDatabaseDiscovery: (discovery) => {
          prepared = discovery;
        },
      });
      if (!deleteFiles) {
        expect(preflight.pendingMigrations?.map((entry) => entry.path)).toEqual([activePath]);
        expect(prepared?.discovery.retainedTargets).toEqual([
          expect.objectContaining({ path: retainedPath, reason: "retained-by-deletion" }),
        ]);
      }
      expect(fs.readFileSync(retainedPath).equals(before)).toBe(true);
      const execPath = path.join(stateDir, "exec-approvals.json");
      fs.writeFileSync(execPath, JSON.stringify({ version: 1, defaults: {}, agents: {} }));
      const result = await autoMigrateLegacyState({
        cfg,
        env,
        agentDatabaseMigrationDiscovery: prepared,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        log: { info() {}, warn() {} },
      });
      expect(readDatabaseSnapshot(activePath).version.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      const migration = result.stepReceipts.find((receipt) => receipt.id === "media-persistence");
      if (deleteFiles) {
        expect(migration).toMatchObject({ outcome: "refused" });
        expect(migration?.warnings.join("\n")).toContain(
          "unavailable while agent retired is deleted",
        );
        expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow(
          "Later repairs were not run",
        );
        expect(fs.existsSync(execPath)).toBe(true);
      } else {
        expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
        expect(migration).toMatchObject({ outcome: "completed", warnings: [] });
        expect(result.notices?.join("\n")).toContain(`retained-by-deletion: ${retainedPath}`);
        const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
        expect(result.notices?.join("\n")).toContain(`openclaw agents add ${quote("retired")}`);
        expect(result.notices?.join("\n")).toContain(
          `--workspace ${quote(workspaceDir)} --agent-dir ${quote(agentDir)} --non-interactive`,
        );
        expect(fs.existsSync(execPath)).toBe(false);
        if (registered && location === "default") {
          await noteSessionTranscriptHealth({
            cfg,
            env,
            shouldRepair: true,
            postSessionPluginMigration: result.postSessionPluginMigration,
            postSessionPluginMigrationPlanBound: true,
          });
          await noteSessionTranscriptHeaderHealth({ cfg, env, shouldRepair: true });
          await noteSessionTranscriptLabelHealth({ cfg, env, shouldRepair: true });
          const runtime = {
            log() {},
            error() {},
            exit(code: number): never {
              throw new Error(`unexpected exit ${code}`);
            },
          };
          const catalogs = await maybeMigrateModelCatalogCredentials({
            cfg,
            env,
            runtime,
            prompter: createDoctorPrompter({
              runtime,
              options: { repair: true, nonInteractive: true },
            }),
          });
          expect(catalogs.warnings).toEqual([]);
          expect(detectTelegramGeneralTopicConversationRepairs({ cfg, env })).toEqual([]);
          expect(
            await maybeRepairCodexSessionRoutes({ cfg, env, shouldRepair: true }),
          ).toMatchObject({ warnings: [] });
          expect(note).not.toHaveBeenCalledWith(
            expect.stringContaining("retired"),
            "Doctor warnings",
          );
        } else {
          expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
            scannedStores: 1,
          });
        }
        await expect(
          assertOpenClawDatabasesReady({
            env,
            operation: "doctor",
            configuredAgentDatabaseTargets: [],
          }),
        ).resolves.toBeUndefined();
        await expect(
          assertOpenClawDatabasesReady({ env, operation: "gateway-restart" }),
        ).resolves.toBeUndefined();
        expect(fs.readFileSync(retainedPath).equals(before)).toBe(true);
      }
      expect(() => openOpenClawAgentDatabase({ agentId: "retired", env })).toThrow(
        "unavailable while agent retired is deleted",
      );
    },
  );
});
