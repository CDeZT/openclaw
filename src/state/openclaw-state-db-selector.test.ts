import { linkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("shared lifecycle source selector custody", () => {
  let directory: string;
  let lifecycle: ReturnType<typeof createOpenClawStateDatabaseAsyncLifecycle>;
  const admission = () => lifecycle.capture(path.join(directory, "state.sqlite"));

  beforeEach(() => {
    directory = tempDirs.make("openclaw-selector-");
    lifecycle = createOpenClawStateDatabaseAsyncLifecycle();
  });

  it("guards each cold borrow without activating a registry or native database", () => {
    const state = admission();
    const first = lifecycle.retainSelector(state);
    const second = lifecycle.retainSelector(state);
    first.release();
    first.release();
    expect(() => first.assertCurrent()).toThrow("selector changed");
    expect(() => second.assertCurrent()).not.toThrow();
    expect(() => state.assertCurrent()).not.toThrow();
    second.release();
  });

  it("hard promotion blocks new readers before mutation and never revives an old witness", () => {
    const state = admission();
    const before = lifecycle.retainSelector(state);
    const writer = lifecycle.beginSelectorMutation(state);
    expect(writer.canPreserve(before)).toBe(true);
    writer.promoteHard();
    writer.promoteHard();
    expect(writer.hard).toBe(true);
    expect(() => before.assertCurrent()).toThrow();
    expect(() => lifecycle.retainSelector(state)).toThrow();
    // Rollback releases the hard interval, not its already-invalidated epoch.
    writer.release();
    const after = lifecycle.retainSelector(state);
    expect(() => after.assertCurrent()).not.toThrow();
    expect(() => before.assertCurrent()).toThrow();
    expect(() => state.assertCurrent()).not.toThrow();
    before.release();
    expect(() => after.assertCurrent()).not.toThrow();
    after.release();
  });

  it("retains the hard interval until all independent mutation owners release", () => {
    const state = admission();
    const first = lifecycle.beginSelectorMutation(state);
    const second = lifecycle.beginSelectorMutation(state);
    first.promoteHard();
    second.promoteHard();
    first.release();
    expect(() => lifecycle.retainSelector(state)).toThrow();
    second.release();
    const fresh = lifecycle.retainSelector(state);
    expect(() => fresh.assertCurrent()).not.toThrow();
    fresh.release();
  });

  it("does not let a late old release unlink a successor lifecycle selector", () => {
    const oldState = admission();
    const oldReader = lifecycle.retainSelector(oldState);
    const oldWriter = lifecycle.beginSelectorMutation(oldState);
    lifecycle.invalidate(oldState.databasePath);
    const newReader = lifecycle.retainSelector(admission());
    expect(() => oldReader.assertCurrent()).toThrow();
    expect(() => oldWriter.promoteHard()).toThrow();
    oldReader.release();
    oldWriter.release();
    expect(() => newReader.assertCurrent()).not.toThrow();
    newReader.release();
  });

  it("keeps root isolation without depending on which registry memo was last active", () => {
    const state = admission();
    const otherState = lifecycle.capture(path.join(directory, "other.sqlite"));
    const selected = lifecycle.retainSelector(state);
    const other = lifecycle.retainSelector(otherState);
    lifecycle.invalidateSelectors(state.databasePath);
    expect(() => selected.assertCurrent()).toThrow();
    expect(() => other.assertCurrent()).not.toThrow();
    expect(() => state.assertCurrent()).not.toThrow();
    selected.release();
    other.release();
  });

  it("hard-invalidates a captured physical owner through a newly observed state alias", () => {
    const pathname = path.join(directory, "state.sqlite");
    writeFileSync(pathname, "identity fixture");
    const state = admission();
    const reader = lifecycle.retainSelector(state);
    const alias = path.join(directory, "state-alias.sqlite");
    linkSync(pathname, alias);
    lifecycle.invalidateSelectors(alias);
    expect(() => reader.assertCurrent()).toThrow("selector changed");
    expect(() => state.assertCurrent()).not.toThrow();
    reader.release();
  });

  it("requires the actual captured admission, not a structurally copied capability", () => {
    const state = admission();
    expect(() => lifecycle.retainSelector({ ...state })).toThrow("Unknown state selector");
    expect(() => lifecycle.beginSelectorMutation({ ...state })).toThrow("Unknown state selector");
  });

  it("does not turn an ordinary metadata intent into a general admission rotation", () => {
    const state = admission();
    const reader = lifecycle.retainSelector(state);
    const writer = lifecycle.beginSelectorMutation(state);
    expect(writer.canPreserve(reader)).toBe(true);
    writer.release();
    expect(() => reader.assertCurrent()).not.toThrow();
    expect(() => state.assertCurrent()).not.toThrow();
    reader.release();
  });

  it("rejects released preservation privilege while retaining independent writer custody", () => {
    const state = admission();
    const reader = lifecycle.retainSelector(state);
    const writer = lifecycle.beginSelectorMutation(state);
    reader.release();
    expect(writer.canPreserve(reader)).toBe(false);
    expect(() => writer.assertCurrent()).not.toThrow();
    writer.promoteHard();
    writer.release();
    expect(() => state.assertCurrent()).not.toThrow();
  });
});
